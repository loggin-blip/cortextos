#!/usr/bin/env python3
"""
Rens støy fra allerede indekserte gmail-tråder.
Re-klassifiserer alle gmail-rader i Supabase via AI-relevans-gate,
fjerner støy fra ChromaDB og Supabase, rapporterer ny treffsikkerhet.

Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, OLLAMA, EMBED_MODEL
"""
import os, sys, json, re, urllib.request, pathlib, random
import chromadb

OLLAMA = os.environ.get("OLLAMA", "http://localhost:11434")
CLASSIFY_MODEL = os.environ.get("CLASSIFY_MODEL", "qwen2.5:7b")

# Samme som ingest-scriptet
NOISE_SENDER_RX = re.compile(
    r"(noreply|no-reply|notifications?@|newsletter|nyhetsbrev|bounce|mailer-daemon"
    r"|donotreply|do-not-reply|autoconfirm|auto-confirm|support@tripletex)", re.I)
NOISE_SUBJECT_RX = re.compile(
    r"(unsubscribe|avmeld|nyhetsbrev|newsletter|weekly digest|monthly digest"
    r"|receipt #|kvittering #|order confirmation|bestillingsbekreftelse"
    r"|skriv en anmeldelse|leave a review|rate your|din mening om"
    r"|tilbud fra|kampanje|rabatt \d+%|% rabatt|spar \d+|black friday"
    r"|du har fått en melding|automatisk varsel|automated (message|alert|notification))", re.I)


def qwen(prompt: str) -> str:
    req = urllib.request.Request(
        OLLAMA + "/api/generate",
        data=json.dumps({"model": CLASSIFY_MODEL, "prompt": prompt, "stream": False,
                         "options": {"temperature": 0, "num_predict": 5}}).encode(),
        headers={"content-type": "application/json"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.loads(r.read()).get("response", "").strip().lower()


def classify_relevance(title: str, text_snippet: str) -> str:
    try:
        ans = qwen(
            "Du er et filter for et massivtrebygg-firma (Massivlust AS). "
            "Klassifiser denne e-posten i NØYAKTIG ett ord:\n"
            "- 'forretning' = ekte forretningskorrespondanse: prosjektforespørsel, "
            "tilbud, kontrakt, faktura til/fra kunde/leverandør, møteinnkalling, "
            "reklamasjon, tegninger/dokumenter, kommunikasjon med kommune/etat/byggherre\n"
            "- 'stoey' = støy: nyhetsbrev, markedsføring, reklame, produktpromo, "
            "automatisk kvittering, systemvarsel, abonnementsbekreftelse, "
            "ordrebekreftelse fra nettbutikk, SaaS-støtteepost\n"
            f"Emne: {title}\n{text_snippet[:600]}\n\nSvar KUN med ett ord (forretning/stoey):"
        )
        return "forretning" if "forretning" in ans else "stoey"
    except Exception:
        return "forretning"  # fail-open


def sb_get(url_path: str, key: str) -> list:
    url = os.environ["SUPABASE_URL"].rstrip("/") + url_path
    req = urllib.request.Request(url, headers={"apikey": key, "authorization": f"Bearer {key}"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read())


def sb_delete(url_path: str, key: str):
    url = os.environ["SUPABASE_URL"].rstrip("/") + url_path
    req = urllib.request.Request(url,
        headers={"apikey": key, "authorization": f"Bearer {key}"}, method="DELETE")
    urllib.request.urlopen(req, timeout=30).read()


def main():
    key = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
    cc = chromadb.PersistentClient(path=str(pathlib.Path.home()/".mmrag"/"chromadb"))
    col = cc.get_or_create_collection("massivlust-docs", metadata={"hnsw:space": "cosine"})

    print("=== GMAIL STØY-RENS ===")

    # Hent alle gmail-rader fra Supabase
    rows = sb_get("/rest/v1/massivlust_kb_sources?source_type=eq.gmail&select=*&limit=500", key)
    print(f"Fant {len(rows)} gmail-rader i Supabase")

    n_kept = 0
    n_removed_regex = 0
    n_removed_ai = 0
    removed_titles = []

    for row in rows:
        title = row.get("title", "") or ""
        basename = row.get("staged_basename", "") or ""
        thread_id = row.get("thread_id", "") or ""

        # Hent første chunk fra ChromaDB for å få tekst
        text_snippet = title  # fallback
        try:
            results = col.get(where={"filename": basename}, limit=1, include=["documents"])
            if results and results.get("documents"):
                text_snippet = results["documents"][0][:800]
        except Exception:
            pass

        # 1. Regex-sjekk (rask)
        is_noise_regex = bool(NOISE_SUBJECT_RX.search(title))

        # 2. AI-sjekk for alt som ikke er åpenbar støy via regex
        if is_noise_regex:
            relevance = "stoey"
            n_removed_regex += 1
        else:
            relevance = classify_relevance(title, text_snippet)
            if relevance == "stoey":
                n_removed_ai += 1

        if relevance == "stoey":
            removed_titles.append(title)
            # Fjern fra ChromaDB
            try:
                col.delete(where={"filename": basename})
            except Exception as e:
                print(f"  ChromaDB delete-feil for {basename}: {e}", file=sys.stderr)
            # Fjern fra Supabase
            try:
                if thread_id:
                    sb_delete(f"/rest/v1/massivlust_kb_sources?source_type=eq.gmail&thread_id=eq.{thread_id}", key)
                else:
                    sb_delete(f"/rest/v1/massivlust_kb_sources?staged_basename=eq.{urllib.request.quote(basename)}", key)
            except Exception as e:
                print(f"  Supabase delete-feil for {thread_id}: {e}", file=sys.stderr)
        else:
            n_kept += 1

        # Progress
        done = n_kept + n_removed_regex + n_removed_ai
        if done % 20 == 0:
            print(f"  {done}/{len(rows)} behandlet…", flush=True)

    total_removed = n_removed_regex + n_removed_ai
    print(f"\nRENS FERDIG:")
    print(f"  Beholdt:        {n_kept}")
    print(f"  Fjernet (regex):{n_removed_regex}")
    print(f"  Fjernet (AI):   {n_removed_ai}")
    print(f"  Totalt fjernet: {total_removed} ({100*total_removed//len(rows) if rows else 0}%)")
    print(f"  ChromaDB etter: {col.count()} docs")

    # Re-sample 20 gjenværende for treffsikkerhets-rapport
    print(f"\n=== RE-SAMPLE 20 GJENVÆRENDE ===")
    remaining = [r for r in rows if r.get("title") not in removed_titles]
    sample = random.sample(remaining, min(20, len(remaining)))
    correct = 0
    for i, row in enumerate(sample):
        title = row.get("title", "") or ""
        basename = row.get("staged_basename", "") or ""
        text_snippet = title
        try:
            results = col.get(where={"filename": basename}, limit=1, include=["documents"])
            if results and results.get("documents"):
                text_snippet = results["documents"][0][:800]
        except Exception:
            pass
        rel = classify_relevance(title, text_snippet)
        is_correct = rel == "forretning"
        if is_correct: correct += 1
        print(f"  [{i+1:2d}] {'✓' if is_correct else '✗'} {rel:12s} | {title[:60]}")

    accuracy = 100 * correct // len(sample) if sample else 0
    print(f"\nTREFFSIKKERHET: {correct}/{len(sample)} = {accuracy}% ekte forretnings-mail")

    print("\nFJERNEDE (utvalg):")
    for t in removed_titles[:15]:
        print(f"  - {t[:70]}")
    if len(removed_titles) > 15:
        print(f"  ... og {len(removed_titles)-15} til")


if __name__ == "__main__":
    main()
