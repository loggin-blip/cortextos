#!/usr/bin/env python3
"""
Mail-inntak — lokalt, gratis. Henter tråder fra angitte postkasser (domain-wide
delegation), ekstraherer tekst, embedder lokalt (bge-m3) → ChromaDB + kilde-register.

Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SA_KEY, OLLAMA, EMBED_MODEL
Arg: <mailbox1,mailbox2,...> [query] [maxThreadsPerBox]
"""
import os, sys, json, re, base64, urllib.request, pathlib
import chromadb
from google.oauth2 import service_account
from googleapiclient.discovery import build

OLLAMA = os.environ.get("OLLAMA", "http://localhost:11434")
EMBED_MODEL = os.environ.get("EMBED_MODEL", "bge-m3")
CLASSIFY_MODEL = os.environ.get("CLASSIFY_MODEL", "qwen2.5:7b")

# Hard sikkerhetsnett for sensitiv persondata — alltid sensitiv uansett klassifisering
SENSITIVE_RX = re.compile(
    r"(lønn|salary|personnummer|fødselsnummer|arbeidsavtale|ansettelse|oppsigelse"
    r"|sykmeld|sykemeld|legeerklær|diagnose|taushet|gdpr|kontonummer|bankkonto)", re.I)

# Åpenbart privat → hopp over ALLTID (ingen AI-kall nødvendig)
PERSONAL_RX = re.compile(
    r"(bursdag|gratulerer med dagen|ferieplan|tinder|date|kjæreste|skilsmisse|begravelse|privat:)", re.I)

# Kjente støy-sendere → skip uten AI-kall
NOISE_SENDER_RX = re.compile(
    r"(noreply|no-reply|notifications?@|newsletter|nyhetsbrev|bounce|mailer-daemon"
    r"|donotreply|do-not-reply|autoconfirm|auto-confirm|support@tripletex)", re.I)

# Kjente støy-emne-mønstre → skip uten AI-kall
NOISE_SUBJECT_RX = re.compile(
    r"(unsubscribe|avmeld|nyhetsbrev|newsletter|weekly digest|monthly digest"
    r"|receipt #|kvittering #|order confirmation|bestillingsbekreftelse"
    r"|skriv en anmeldelse|leave a review|rate your|din mening om"
    r"|tilbud fra|kampanje|rabatt \d+%|% rabatt|spar \d+|black friday"
    r"|du har fått en melding|automatisk varsel|automated (message|alert|notification))", re.I)


def qwen(prompt: str, num_predict: int = 5) -> str:
    """Kjør lokal qwen2.5:7b og returner svar-teksten."""
    req = urllib.request.Request(
        OLLAMA + "/api/generate",
        data=json.dumps({
            "model": CLASSIFY_MODEL,
            "prompt": prompt,
            "stream": False,
            "options": {"temperature": 0, "num_predict": num_predict},
        }).encode(),
        headers={"content-type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.loads(r.read()).get("response", "").strip().lower()


def classify_relevance(subject: str, snippet: str) -> str:
    """
    Relevansvurdering for Massivlust (massivtrebygg-firma).
    Returner 'forretning' eller 'stoey'.

    Indekser: prosjektforespørsler, tilbud, fakturaer, møter, kontrakter,
              reklamasjoner, tegninger, kommunepost, leverandørsvar.
    Hopp over: nyhetsbrev, markedsføring, automatiske kvitteringer/varsler
               uten prosjektkobling, systemnotifikasjoner, reklame.
    """
    try:
        ans = qwen(
            "Du er et filter for et massivtrebygg-firma (Massivlust AS). "
            "Klassifiser denne e-posten i NØYAKTIG ett ord:\n"
            "- 'forretning' = ekte forretningskorrespondanse: prosjektforespørsel, "
            "tilbud, kontrakt, faktura til/fra kunde/leverandør, møteinnkalling, "
            "reklamasjon, tegninger/dokumenter, kommunikasjon med kommune/etat/byggherre\n"
            "- 'stoey' = støy som IKKE skal indekseres: nyhetsbrev, markedsføring, "
            "reklame, produktpromo, automatisk kvittering, systemvarsel, "
            "abonnementsbekreftelse, ordrebekreftelse fra nettbutikk, "
            "purring/inkasso uten prosjektkobling, støtte-e-post fra SaaS-verktøy\n"
            f"Emne: {subject}\n{snippet[:600]}\n\nSvar KUN med ett ord (forretning/stoey):"
        )
        return "forretning" if "forretning" in ans else "stoey"
    except Exception:
        return "forretning"  # fail-open: usikker → behandle som relevant


def classify_privacy(subject: str, snippet: str) -> str:
    """Lokal klassifisering (gratis): arbeid | personlig | sensitiv."""
    try:
        ans = qwen(
            "Klassifiser denne e-posten i NØYAKTIG ett ord:\n"
            "- 'arbeid' = jobb, prosjekt, kunde, leverandør, faktura, bygg\n"
            "- 'personlig' = privat, ikke jobbrelatert\n"
            "- 'sensitiv' = lønn, helse, personnummer, HR, ansattkontrakt, bank\n"
            f"E-post — emne: {subject}\n{snippet[:600]}\n\nSvar KUN med ett ord:"
        )
        if "sensitiv" in ans: return "sensitiv"
        if "personlig" in ans: return "personlig"
        return "arbeid"
    except Exception:
        return "arbeid"


DEFAULT_Q = ("newer_than:12m in:inbox -in:spam -in:trash -category:promotions "
             "-category:social -category:forums -from:noreply -from:no-reply -from:notifications")


def embed(text):
    req = urllib.request.Request(OLLAMA + "/api/embed",
        data=json.dumps({"model": EMBED_MODEL, "input": text[:8000]}).encode(),
        headers={"content-type": "application/json"})
    with urllib.request.urlopen(req, timeout=120) as r:
        return json.loads(r.read())["embeddings"][0]


def gmail_for(user):
    creds = service_account.Credentials.from_service_account_file(
        os.environ["SA_KEY"], scopes=["https://www.googleapis.com/auth/gmail.modify"], subject=user)
    return build("gmail", "v1", credentials=creds)


def b64(d): return base64.urlsafe_b64decode(d + "=" * (-len(d) % 4)).decode("utf-8", "ignore")
def strip_html(h):
    h = re.sub(r"<(style|script)[\s\S]*?</\1>", " ", h, flags=re.I)
    return re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", h)).strip()
def body(payload):
    plain, html = [], []
    def walk(p):
        if not p: return
        mt, data = p.get("mimeType", ""), (p.get("body") or {}).get("data")
        if mt == "text/plain" and data: plain.append(b64(data))
        elif mt == "text/html" and data: html.append(b64(data))
        for c in p.get("parts", []) or []: walk(c)
    walk(payload)
    return ("\n".join(plain).strip() or strip_html("\n".join(html)))


def chunk(t, size=1500):
    t = (t or "").strip()
    return [t[i:i+size] for i in range(0, len(t), size)] if t else []


def main():
    boxes = sys.argv[1].split(",")
    query = sys.argv[2] if len(sys.argv) > 2 and sys.argv[2] else DEFAULT_Q
    maxt = int(sys.argv[3]) if len(sys.argv) > 3 else 150
    # optional: page offset (skip first N threads) to continue from where we left off
    page_skip = int(sys.argv[4]) if len(sys.argv) > 4 else 0
    cc = chromadb.PersistentClient(path=str(pathlib.Path.home()/".mmrag"/"chromadb"))
    col = cc.get_or_create_collection("massivlust-docs", metadata={"hnsw:space": "cosine"})
    rows, n_ok, n_chunks, n_skipped_privacy, n_skipped_noise = [], 0, 0, 0, 0

    for box in boxes:
        box = box.strip()
        try:
            g = gmail_for(box)
            # Paginate to skip already-processed threads and fetch the right window
            all_threads, page_token = [], None
            remaining_skip = page_skip
            while True:
                kwargs = {"userId": "me", "q": query, "maxResults": min(500, maxt + page_skip)}
                if page_token:
                    kwargs["pageToken"] = page_token
                resp = g.users().threads().list(**kwargs).execute()
                batch = resp.get("threads", [])
                if remaining_skip > 0:
                    skip_now = min(remaining_skip, len(batch))
                    batch = batch[skip_now:]
                    remaining_skip -= skip_now
                all_threads.extend(batch)
                if len(all_threads) >= maxt or not resp.get("nextPageToken"):
                    break
                page_token = resp["nextPageToken"]
            threads = all_threads[:maxt]
        except Exception as e:
            print(f"  postkasse {box} feilet: {e}", file=sys.stderr); continue
        print(f"  {box}: {len(threads)} tråder (offset {page_skip})")

        for t in threads:
            try:
                full = g.users().threads().get(userId="me", id=t["id"], format="full").execute()
                msgs = full.get("messages", [])
                h0 = {x["name"].lower(): x["value"] for x in (msgs[0].get("payload", {}).get("headers", []))}
                subj = h0.get("subject", "(uten emne)")
                frm = h0.get("from", "")
                last = msgs[-1]
                last_date = None
                if last.get("internalDate"):
                    import datetime
                    last_date = datetime.datetime.utcfromtimestamp(int(last["internalDate"])/1000).isoformat() + "Z"

                parts = [f"Emne: {subj}"]
                for m in msgs:
                    mh = {x["name"].lower(): x["value"] for x in (m.get("payload", {}).get("headers", []))}
                    parts.append(f"\n--- Fra: {mh.get('from','')} | {mh.get('date','')} ---\n{body(m.get('payload'))[:4000]}")
                text = "\n".join(parts)[:16000]
                if not text.strip(): continue

                snippet = text[:800]

                # ── 1. Regex-snarveier: åpenbart privat eller kjent støy → skip ──
                if PERSONAL_RX.search(subj) or PERSONAL_RX.search(snippet):
                    n_skipped_privacy += 1; continue
                if NOISE_SENDER_RX.search(frm) or NOISE_SUBJECT_RX.search(subj):
                    n_skipped_noise += 1; continue

                # ── 2. AI relevans-gate (qwen2.5:7b, lokal) ──────────────────────
                relevance = classify_relevance(subj, snippet)
                if relevance == "stoey":
                    n_skipped_noise += 1; continue

                # ── 3. AI personvern-klassifisering ──────────────────────────────
                cls = classify_privacy(subj, snippet)
                if cls == "personlig":
                    n_skipped_privacy += 1; continue

                # Sensitive: kun ekte HR/helse/finans — ALDRI markedsføring
                if cls == "sensitiv" or SENSITIVE_RX.search(subj) or SENSITIVE_RX.search(snippet):
                    scope = "sensitive"
                else:
                    scope = "project"

                base = f"gmail-{t['id']}__{re.sub(r'[^\\w.\\-æøåÆØÅ ]+','_',subj)[:50].strip()}.txt"
                chunks = [c for c in chunk(text) if c.strip()]
                ids, docs, metas, embs = [], [], [], []
                for ci, ch in enumerate(chunks[:20]):
                    ids.append(f"{base}#{ci}"); docs.append(ch)
                    metas.append({"filename": base, "type": "text", "chunk_index": ci,
                                  "access_scope": scope, "mailbox": box})
                    embs.append(embed(ch))
                try: col.delete(where={"filename": base})
                except Exception: pass
                col.add(ids=ids, documents=docs, metadatas=metas, embeddings=embs)
                n_ok += 1; n_chunks += len(ids)
                rows.append({
                    "org_id": "massivlust", "collection": "massivlust-docs" if scope == "project" else "massivlust-sensitive",
                    "source_type": "gmail", "staged_basename": base, "drive_file_id": None,
                    "parent_folder_id": None, "web_view_link": None, "thread_id": t["id"],
                    "project_id": None, "title": subj, "mime_type": "text/plain",
                    "access_scope": scope, "file_modified_at": last_date, "chunk_count": len(ids),
                })
                if n_ok % 25 == 0: print(f"  {n_ok} tråder, {n_chunks} chunks…", flush=True)

            except Exception as e:
                print(f"    tråd-feil: {e}", file=sys.stderr)

    if rows:
        url = os.environ["SUPABASE_URL"].rstrip("/") + "/rest/v1/massivlust_kb_sources?on_conflict=source_type,thread_id"
        key = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
        for i in range(0, len(rows), 100):
            req = urllib.request.Request(url, data=json.dumps(rows[i:i+100]).encode(),
                headers={"apikey": key, "authorization": f"Bearer {key}",
                         "content-type": "application/json", "prefer": "resolution=merge-duplicates"}, method="POST")
            try: urllib.request.urlopen(req, timeout=60).read()
            except Exception as e: print(f"  kilde-register-feil: {e}", file=sys.stderr)

    print(f"MAIL FERDIG: {n_ok} indeksert, {n_skipped_noise} støy, {n_skipped_privacy} privat, {n_chunks} chunks. Collection: {col.count()}")


if __name__ == "__main__":
    main()
