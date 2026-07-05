#!/usr/bin/env python3
"""Embed mail body + vedlegg-PDF inn i Massivlust KB (ChromaDB).

Plukker rader fra Supabase som ikke er indeksert (kb_indexed_at IS NULL),
embedder lokalt via bge-m3 (Ollama), klassifiserer privacy via qwen2.5:7b,
skriver til collection 'massivlust-docs' (eller 'massivlust-sensitive' for sensitive).
Setter kb_indexed_at = now() når ferdig.

Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, OLLAMA (default localhost:11434)
Arg: --mode=mail|attachment  --limit=N
"""
import os, sys, json, re, urllib.request, pathlib, argparse
from datetime import datetime, timezone

import chromadb
from pypdf import PdfReader
from io import BytesIO

OLLAMA = os.environ.get("OLLAMA", "http://localhost:11434")
EMBED_MODEL = os.environ.get("EMBED_MODEL", "bge-m3")
CLASSIFY_MODEL = os.environ.get("CLASSIFY_MODEL", "qwen2.5:7b")
SUPA_URL = os.environ["SUPABASE_URL"].rstrip("/")
SUPA_KEY = os.environ["SUPABASE_SERVICE_ROLE_KEY"]

CHROMA_PATH = str(pathlib.Path.home() / ".mmrag" / "chromadb")

SENSITIVE_RX = re.compile(
    r"(lønn|salary|personnummer|fødselsnummer|arbeidsavtale|ansettelse|oppsigelse|"
    r"sykmeld|sykemeld|legeerklær|diagnose|taushet|gdpr|kontonummer|bankkonto)",
    re.I,
)
PERSONAL_RX = re.compile(
    r"(bursdag|gratulerer med dagen|ferieplan|tinder|date|kjæreste|skilsmisse|"
    r"begravelse|privat:)",
    re.I,
)


def _clean_meta(m: dict) -> dict:
    """ChromaDB only accepts str/int/float/bool — strip None and coerce the rest."""
    out = {}
    for k, v in m.items():
        if v is None:
            out[k] = ""
        elif isinstance(v, (str, int, float, bool)):
            out[k] = v
        else:
            out[k] = str(v)
    return out


def supa(method, path, body=None, query=None):
    url = f"{SUPA_URL}/rest/v1/{path}"
    if query:
        url += "?" + query
    headers = {
        "apikey": SUPA_KEY,
        "authorization": f"Bearer {SUPA_KEY}",
        "content-type": "application/json",
        "prefer": "return=representation",
    }
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    with urllib.request.urlopen(req, timeout=60) as r:
        body = r.read()
        return json.loads(body) if body else None


def embed(text):
    req = urllib.request.Request(
        OLLAMA + "/api/embed",
        data=json.dumps({"model": EMBED_MODEL, "input": text[:8000]}).encode(),
        headers={"content-type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=120) as r:
        return json.loads(r.read())["embeddings"][0]


def classify_privacy(subject, snippet):
    try:
        req = urllib.request.Request(
            OLLAMA + "/api/generate",
            data=json.dumps({
                "model": CLASSIFY_MODEL,
                "prompt": (
                    "Klassifiser denne e-posten i NØYAKTIG ett ord:\n"
                    "- 'arbeid' = jobb, prosjekt, kunde, leverandør, faktura, bygg\n"
                    "- 'personlig' = privat, ikke jobbrelatert\n"
                    "- 'sensitiv' = lønn, helse, personnummer, HR, ansattkontrakt, bank\n"
                    f"E-post — emne: {subject}\n{snippet[:600]}\n\nSvar KUN med ett ord:"
                ),
                "stream": False,
                "options": {"temperature": 0, "num_predict": 5},
            }).encode(),
            headers={"content-type": "application/json"},
        )
        with urllib.request.urlopen(req, timeout=60) as r:
            ans = json.loads(r.read()).get("response", "").strip().lower()
        if "sensitiv" in ans:
            return "sensitiv"
        if "personlig" in ans:
            return "personlig"
        return "arbeid"
    except Exception:
        return "arbeid"


def determine_scope(subject, snippet):
    if PERSONAL_RX.search(subject) or PERSONAL_RX.search(snippet):
        return "skip"
    cls = classify_privacy(subject, snippet)
    if cls == "personlig":
        return "skip"
    if cls == "sensitiv" or SENSITIVE_RX.search(subject) or SENSITIVE_RX.search(snippet):
        return "sensitive"
    return "project"


def collection_for(scope):
    name = "massivlust-sensitive" if scope == "sensitive" else "massivlust-docs"
    cc = chromadb.PersistentClient(path=CHROMA_PATH)
    return cc.get_or_create_collection(name, metadata={"hnsw:space": "cosine"})


def chunk(t, size=1500):
    t = (t or "").strip()
    return [t[i : i + size] for i in range(0, len(t), size)] if t else []


def now_iso():
    return datetime.now(timezone.utc).isoformat()


def project_cache():
    rows = supa("GET", "massivlust_projects", query="select=id,name&limit=2000")
    return {r["id"]: r["name"] for r in (rows or [])}


def mark_indexed(table, key_col, key_val, scope=None):
    body = {"kb_indexed_at": now_iso()}
    if scope and table == "massivlust_korrespondanse":
        body["kb_access_scope"] = scope
    supa("PATCH", table, body=body, query=f"{key_col}=eq.{key_val}")


def process_mails(limit):
    cache = project_cache()
    rows = supa(
        "GET",
        "massivlust_korrespondanse",
        query=(
            "select=gmail_message_id,project_id,dato,source_mailbox,emne,fra_navn,fra_epost,til_navn,innhold,raw_payload"
            "&kb_indexed_at=is.null"
            "&project_id=not.is.null"
            f"&order=dato.desc&limit={limit}"
        ),
    )
    if not rows:
        print(json.dumps({"mode": "mail", "indexed": 0, "skipped": 0}))
        return

    n_idx = 0
    n_skip = 0
    for r in rows:
        mid = r["gmail_message_id"]
        subj = (r.get("emne") or "(uten emne)")[:300]
        body = r.get("innhold") or extract_body((r.get("raw_payload") or {}).get("payload") or {})
        if not body or len(body.strip()) < 20:
            mark_indexed("massivlust_korrespondanse", "gmail_message_id", mid, "empty")
            n_skip += 1
            continue

        snippet = body[:800]
        scope = determine_scope(subj, snippet)
        if scope == "skip":
            mark_indexed("massivlust_korrespondanse", "gmail_message_id", mid, "personlig")
            n_skip += 1
            continue

        proj_name = cache.get(r["project_id"])
        header = (
            f"Emne: {subj}\n"
            f"Fra: {r.get('fra_navn') or ''} <{r.get('fra_epost') or ''}>\n"
            f"Til: {r.get('til_navn') or ''}\n"
            f"Dato: {r.get('dato') or ''}\n"
            f"Prosjekt: {proj_name or ''}\n"
            f"Postkasse: {r.get('source_mailbox') or ''}\n\n"
        )
        full_text = (header + body)[:16000]

        col = collection_for(scope)
        chunks = [c for c in chunk(full_text) if c.strip()]
        if not chunks:
            mark_indexed("massivlust_korrespondanse", "gmail_message_id", mid, "empty")
            n_skip += 1
            continue

        base = f"gmail-{mid}__{re.sub(r'[^\w.\-æøåÆØÅ ]+', '_', subj)[:50].strip()}.txt"
        ids, docs, metas, embs = [], [], [], []
        for ci, ch in enumerate(chunks[:20]):
            ids.append(f"{base}#{ci}")
            docs.append(ch)
            metas.append({
                "filename": base,
                "type": "mail",
                "document_type": "mail",
                "chunk_index": ci,
                "access_scope": scope,
                "mailbox": r.get("source_mailbox"),
                "project": proj_name,
                "project_id": r["project_id"],
                "subject": subj,
                "from": r.get("fra_epost"),
                "dato": str(r.get("dato") or ""),
                "gmail_message_id": mid,
            })
            embs.append(embed(ch))
        try:
            col.delete(where={"filename": base})
        except Exception:
            pass
        col.add(ids=ids, documents=docs, metadatas=[_clean_meta(m) for m in metas], embeddings=embs)

        mark_indexed("massivlust_korrespondanse", "gmail_message_id", mid, scope)
        n_idx += 1

    print(json.dumps({"mode": "mail", "indexed": n_idx, "skipped": n_skip}))


def b64dec(s):
    import base64
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4)).decode("utf-8", "ignore")


def strip_html(h):
    h = re.sub(r"<(style|script)[\s\S]*?</\1>", " ", h, flags=re.I)
    return re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", h)).strip()


def extract_body(payload):
    plain, html = [], []

    def walk(p):
        if not p:
            return
        mt = p.get("mimeType", "")
        data = (p.get("body") or {}).get("data")
        if mt == "text/plain" and data:
            plain.append(b64dec(data))
        elif mt == "text/html" and data:
            html.append(b64dec(data))
        for c in p.get("parts", []) or []:
            walk(c)

    walk(payload)
    return ("\n".join(plain).strip() or strip_html("\n".join(html)))


def process_attachments(limit):
    cache = project_cache()
    rows = supa(
        "GET",
        "massivlust_dokumenter",
        query=(
            "select=id,project_id,filnavn,mime_type,drive_file_id,source_gmail_message_id,source_mailbox,dato"
            "&kb_indexed_at=is.null"
            "&type=eq.mail_vedlegg"
            f"&order=created_at.desc&limit={limit}"
        ),
    )
    if not rows:
        print(json.dumps({"mode": "attachment", "indexed": 0, "skipped": 0}))
        return

    # Lazy import to avoid loading google libs unless needed
    from googleapiclient.discovery import build
    from google.oauth2 import service_account

    sa_key_path = os.environ.get("SA_KEY") or os.environ.get("GOOGLE_SA_KEY_PATH")
    if not sa_key_path:
        print(json.dumps({"mode": "attachment", "error": "SA_KEY/GOOGLE_SA_KEY_PATH not set"}))
        return

    n_idx = 0
    n_skip = 0
    drive_cache = {}

    for r in rows:
        doc_id = r["id"]
        filename = r.get("filnavn") or ""
        mime = r.get("mime_type") or ""
        drive_file_id = r.get("drive_file_id")

        if not drive_file_id:
            mark_indexed("massivlust_dokumenter", "id", doc_id)
            n_skip += 1
            continue

        if "pdf" not in mime.lower() and not filename.lower().endswith(".pdf"):
            # bilder/andre — hopp i denne første versjonen
            mark_indexed("massivlust_dokumenter", "id", doc_id)
            n_skip += 1
            continue

        impersonate = r.get("source_mailbox") or "alex@massivlust.no"
        if impersonate not in drive_cache:
            creds = service_account.Credentials.from_service_account_file(
                sa_key_path,
                scopes=["https://www.googleapis.com/auth/drive.readonly"],
                subject=impersonate,
            )
            drive_cache[impersonate] = build("drive", "v3", credentials=creds)
        drive = drive_cache[impersonate]

        try:
            file_bytes = drive.files().get_media(
                fileId=drive_file_id, supportsAllDrives=True
            ).execute()
        except Exception as e:
            print(f"  drive-get feilet {doc_id}: {e}", file=sys.stderr)
            n_skip += 1
            continue

        try:
            reader = PdfReader(BytesIO(file_bytes))
            text = "\n".join((p.extract_text() or "") for p in reader.pages)
        except Exception as e:
            print(f"  pdf-parse feilet {doc_id}: {e}", file=sys.stderr)
            mark_indexed("massivlust_dokumenter", "id", doc_id)
            n_skip += 1
            continue

        if not text.strip() or len(text.strip()) < 30:
            mark_indexed("massivlust_dokumenter", "id", doc_id)
            n_skip += 1
            continue

        proj_name = cache.get(r["project_id"])
        chunks = [c for c in chunk(text) if c.strip()]
        if not chunks:
            mark_indexed("massivlust_dokumenter", "id", doc_id)
            n_skip += 1
            continue

        col = collection_for("project")
        base = f"{drive_file_id}___{re.sub(r'[^\w.\-æøåÆØÅ ]+', '_', filename)[:80]}"
        ids, docs, metas, embs = [], [], [], []
        for ci, ch in enumerate(chunks[:30]):
            ids.append(f"{base}#{ci}")
            docs.append(ch)
            metas.append({
                "filename": base,
                "type": "mail_vedlegg",
                "document_type": "mail_vedlegg",
                "chunk_index": ci,
                "access_scope": "project",
                "mailbox": r.get("source_mailbox"),
                "project": proj_name,
                "project_id": r["project_id"],
                "drive_file_id": drive_file_id,
                "link": f"https://drive.google.com/file/d/{drive_file_id}/view",
                "source_gmail_message_id": r.get("source_gmail_message_id"),
                "dato": str(r.get("dato") or ""),
                "mime_type": mime,
            })
            embs.append(embed(ch))
        try:
            col.delete(where={"filename": base})
        except Exception:
            pass
        col.add(ids=ids, documents=docs, metadatas=[_clean_meta(m) for m in metas], embeddings=embs)

        mark_indexed("massivlust_dokumenter", "id", doc_id)
        n_idx += 1

    print(json.dumps({"mode": "attachment", "indexed": n_idx, "skipped": n_skip}))


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--mode", choices=["mail", "attachment", "both"], default="both")
    p.add_argument("--limit", type=int, default=50)
    a = p.parse_args()
    if a.mode in ("mail", "both"):
        process_mails(a.limit)
    if a.mode in ("attachment", "both"):
        process_attachments(a.limit)


if __name__ == "__main__":
    main()
