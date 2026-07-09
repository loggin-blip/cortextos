#!/usr/bin/env python3
"""
ml-kb-sync.py — Nightly Massivlust KB auto-sync (Mac Studio, launchd 03:00)

Drive part:  Walk massivlust_drive_folders → driveFileIsStale gate
             → bge-m3 (Ollama local) → ChromaDB massivlust-docs
             Same embed model + collection as local_query.py and studio_ingest.py.
Mail part:   mailkb-harvest.cjs (ML_NEWER_THAN=2d) → mailkb-classify.cjs → mailkb-embed.py
PAUSE file:  ~/.cortextos/ml-kb-sync/PAUSE  (touch to freeze)
Log:         ~/.cortextos/ml-kb-sync/YYYY-MM-DD.log  (JSON lines)

Usage:
  python3 ml-kb-sync.py [--dry-run] [--skip-drive] [--skip-mail] [--limit N]
"""
import argparse
import datetime
import fcntl
import io
import json
import os
import re
import subprocess
import sys
import tempfile
import time
import urllib.request
import urllib.error
from pathlib import Path

# ── Paths ────────────────────────────────────────────────────────────────────
HOME         = Path.home()
SYNC_DIR     = HOME / ".cortextos" / "ml-kb-sync"
PAUSE_FILE   = SYNC_DIR / "PAUSE"
LOCK_FILE    = SYNC_DIR / "ml-kb-sync.lock"
VENV_PY      = HOME / "cortextos" / "knowledge-base" / "venv" / "bin" / "python3"
HARVEST_CJS  = HOME / "mail-ab-test" / "mailkb-harvest.cjs"
CLASSIFY_CJS = HOME / "mail-ab-test" / "mailkb-classify.cjs"
EMBED_PY     = HOME / "mail-ab-test" / "mailkb-embed.py"
SA_KEY       = HOME / "cortextos" / "builds" / "massivlust-gmail-service" / "google-sa-key.json"
KB_ENV_FILE  = HOME / "cortextos" / "builds" / "massivlust-kb-service" / ".env"
CHROMA_PATH  = str(HOME / ".mmrag" / "chromadb")
COLLECTION   = "massivlust-docs"
COLLECTION_S = "massivlust-sensitive"

# ── Config ───────────────────────────────────────────────────────────────────
SUPA_URL        = "https://wnnrtmtgtzcwqobnnzyo.supabase.co"
ORG_ID          = "massivlust"
DRIVE_USER      = "alex@massivlust.no"
OLLAMA          = os.environ.get("OLLAMA", "http://localhost:11434")
EMBED_MODEL     = "bge-m3"
MAIL_NEWER_THAN = "2d"
CHUNK_SIZE      = 1500

SENSITIVE_RX = re.compile(
    r"lønn|salary|personnummer|fødselsnummer|arbeidsavtale|ansettelse|"
    r"oppsigelse|sykmeld|sykemeld|legeerklær|diagnose|taushet|gdpr|"
    r"kontonummer|bankkonto", re.I)

GOOGLE_EXPORT = {
    "application/vnd.google-apps.document":     ("text/plain", ".txt"),
    "application/vnd.google-apps.spreadsheet":  ("text/csv",   ".csv"),
    "application/vnd.google-apps.presentation": ("text/plain", ".txt"),
}

SKIP_MIME = {
    "application/vnd.google-apps.folder",
    "application/vnd.google-apps.shortcut",
    "application/vnd.google-apps.form",
}

# Binary formats we skip entirely (no local vision model in this runner)
SKIP_EXT = {
    ".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp", ".tiff", ".tif", ".heic",
    ".mp4", ".mov", ".avi", ".mkv", ".webm", ".m4v",
    ".mp3", ".wav", ".m4a", ".ogg", ".flac",
    ".dwg", ".dxf", ".rvt", ".ifc",  # CAD/BIM — already handled by drive-ifc sync
    ".zip", ".rar", ".7z", ".tar", ".gz",
    ".exe", ".dmg", ".pkg",
}

# ── Supabase helpers ─────────────────────────────────────────────────────────
def _load_supa_key():
    txt = KB_ENV_FILE.read_text()
    return re.search(r"SUPABASE_SERVICE_ROLE_KEY\s*=\s*(.+)", txt).group(1).strip().strip('"').strip("'")

SUPA_KEY = _load_supa_key()

def _supa_req(method, path, query="", body=None, prefer=None):
    url = f"{SUPA_URL}/rest/v1/{path}"
    if query:
        url += "?" + query
    headers = {
        "apikey": SUPA_KEY,
        "Authorization": f"Bearer {SUPA_KEY}",
        "Content-Type": "application/json",
    }
    if prefer:
        headers["Prefer"] = prefer
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            raw = r.read()
            return json.loads(raw) if raw.strip() else []
    except urllib.error.HTTPError as e:
        raise RuntimeError(f"Supabase {method} {path}: HTTP {e.code} {e.read().decode()[:300]}")

def supa_get_all(path, query=""):
    out, offset, step = [], 0, 1000
    while True:
        q = query + ("&" if query else "") + f"limit={step}&offset={offset}"
        rows = _supa_req("GET", path, q)
        if not isinstance(rows, list) or not rows:
            break
        out.extend(rows)
        if len(rows) < step:
            break
        offset += step
    return out

def supa_upsert(path, conflict_cols, rows):
    if not rows:
        return
    conflict = ",".join(conflict_cols)
    for i in range(0, len(rows), 100):
        _supa_req("POST", path,
                  query=f"on_conflict={conflict}",
                  body=rows[i:i+100],
                  prefer="resolution=merge-duplicates")

# ── Embed (bge-m3, same model as local_query.py) ────────────────────────────
def embed_bge(text):
    req = urllib.request.Request(
        OLLAMA + "/api/embed",
        data=json.dumps({"model": EMBED_MODEL, "input": text[:8000]}).encode(),
        headers={"content-type": "application/json"})
    with urllib.request.urlopen(req, timeout=120) as r:
        return json.loads(r.read())["embeddings"][0]

# ── Text extraction (text-only, no vision — same as studio_ingest TEXT_ONLY=1) ──
def extract_text(data: bytes, ext: str, mime: str, name: str) -> list[str]:
    """Returns list of text chunks (one per page/section). Empty = skip."""
    if ext in SKIP_EXT or mime.startswith(("image/", "video/", "audio/")):
        return []
    try:
        # Plain text / CSV / markdown
        if ext in {".txt", ".csv", ".md", ".json", ".py", ".js", ".ts", ".sql",
                   ".yaml", ".yml", ".toml", ".html"}:
            return [data.decode("utf-8", "replace")]

        # Word documents
        if ext == ".docx":
            import docx
            d = docx.Document(io.BytesIO(data))
            return ["\n".join(p.text for p in d.paragraphs if p.text.strip())]

        # PDFs — text extraction only (no vision rendering)
        if ext == ".pdf":
            chunks = []
            try:
                import fitz
                doc = fitz.open(stream=data, filetype="pdf")
                for page in doc:
                    txt = page.get_text().strip()
                    if txt:
                        chunks.append(txt)
            except Exception:
                try:
                    from pypdf import PdfReader
                    reader = PdfReader(io.BytesIO(data))
                    for pg in reader.pages:
                        t = (pg.extract_text() or "").strip()
                        if t:
                            chunks.append(t)
                except Exception:
                    pass
            return chunks or [name]

        # Excel
        if ext in {".xlsx", ".xls"}:
            try:
                import openpyxl
                wb = openpyxl.load_workbook(io.BytesIO(data), read_only=True, data_only=True)
                rows = []
                for ws in wb.worksheets:
                    for row in ws.iter_rows(values_only=True):
                        r = " | ".join(str(c) for c in row if c is not None)
                        if r.strip():
                            rows.append(r)
                return ["\n".join(rows)] if rows else []
            except Exception:
                return []

        # Fallback: try UTF-8 decode
        decoded = data.decode("utf-8", "replace")
        if decoded.strip():
            return [decoded]
        return []

    except Exception as e:
        print(f"  extract error {name}: {e}", file=sys.stderr)
        return []

def chunk_text(text: str, size: int = CHUNK_SIZE) -> list[str]:
    """Split text into overlapping chunks of ~size chars."""
    paragraphs = [p.strip() for p in re.split(r"\n{2,}", text) if p.strip()]
    chunks, current = [], ""
    for para in paragraphs:
        if len(current) + len(para) + 1 > size and current:
            chunks.append(current.strip())
            current = para
        else:
            current = (current + "\n\n" + para) if current else para
    if current.strip():
        chunks.append(current.strip())
    # Hard-split paragraphs that are themselves too long
    out = []
    for c in chunks:
        if len(c) <= size:
            out.append(c)
        else:
            for i in range(0, len(c), size):
                out.append(c[i:i+size])
    return out

# ── Gate (port of driveFileIsStale from kb-ingest.ts) ───────────────────────
_ABSENT = object()

def fetch_stored_mod_times(file_ids):
    if not file_ids:
        return {}
    out = {}
    chunk = 200
    for i in range(0, len(file_ids), chunk):
        ids = file_ids[i:i+chunk]
        filt = ",".join(f'"{x}"' for x in ids)
        rows = _supa_req("GET", "massivlust_kb_sources",
                         f"select=drive_file_id,file_modified_at"
                         f"&source_type=eq.drive"
                         f"&drive_file_id=in.({filt})")
        for r in rows:
            out[r["drive_file_id"]] = r.get("file_modified_at")
    return out

def is_stale(drive_mod_time, stored):
    """
    stored=_ABSENT → new file → True (process)
    stored=None    → legacy null-row → False (SKIP, never re-embed)
    stored=str     → compare; True only if Drive is strictly newer
    """
    if stored is _ABSENT:
        return True
    if stored is None or not drive_mod_time:
        return False
    try:
        t_drive = datetime.datetime.fromisoformat(drive_mod_time.replace("Z", "+00:00"))
        t_stored = datetime.datetime.fromisoformat(stored.replace("Z", "+00:00"))
        return t_drive > t_stored
    except ValueError:
        return False

# ── Drive API ────────────────────────────────────────────────────────────────
def drive_client():
    from google.oauth2 import service_account
    from googleapiclient.discovery import build
    creds = service_account.Credentials.from_service_account_file(
        str(SA_KEY),
        scopes=["https://www.googleapis.com/auth/drive"],
        subject=DRIVE_USER)
    return build("drive", "v3", credentials=creds)

def list_files_in_folder(drive, folder_id):
    out, tok = [], None
    while True:
        r = drive.files().list(
            q=(f"'{folder_id}' in parents and trashed=false"
               f" and mimeType != 'application/vnd.google-apps.folder'"),
            fields="files(id,name,mimeType,size,modifiedTime,webViewLink,parents),nextPageToken",
            pageSize=200,
            supportsAllDrives=True,
            includeItemsFromAllDrives=True,
            corpora="allDrives",
            pageToken=tok,
        ).execute()
        out.extend(r.get("files", []))
        tok = r.get("nextPageToken")
        if not tok:
            break
    return out

def download_bytes(drive, f):
    """Download Drive file bytes. Returns (bytes, ext) or (None, None)."""
    from googleapiclient.http import MediaIoBaseDownload
    mt = f["mimeType"]
    if mt in SKIP_MIME:
        return None, None
    if mt in GOOGLE_EXPORT:
        exp_mt, ext = GOOGLE_EXPORT[mt]
        try:
            data = drive.files().export(fileId=f["id"], mimeType=exp_mt).execute()
            return (data if isinstance(data, bytes) else data.encode("utf-8", "replace")), ext
        except Exception:
            return None, None
    buf = io.BytesIO()
    try:
        req = drive.files().get_media(fileId=f["id"], supportsAllDrives=True)
        dl = MediaIoBaseDownload(buf, req)
        done = False
        while not done:
            _, done = dl.next_chunk()
        ext = Path(f.get("name", "")).suffix.lower() or ""
        return buf.getvalue(), ext
    except Exception:
        return None, None

# ── Wait for embed-korrespondanse.py before writing to ChromaDB ──────────────
def wait_for_embed_clear(timeout=90):
    deadline = time.time() + timeout
    while time.time() < deadline:
        r = subprocess.run(["pgrep", "-f", "embed-korrespondanse.py"], capture_output=True)
        if r.returncode != 0:
            return True
        time.sleep(8)
    return False

# ── Drive sync ───────────────────────────────────────────────────────────────
def sync_drive(dry_run, limit, log):
    import chromadb

    drive = drive_client()

    folders = supa_get_all("massivlust_drive_folders",
                           "select=drive_folder_id,path_full&org_id=eq.massivlust")
    folder_ids = [f["drive_folder_id"] for f in folders]
    log_info(log, f"drive: {len(folder_ids)} folders in db")

    # Collect all unique files across all folders
    files_by_id = {}
    for fid in folder_ids:
        try:
            for f in list_files_in_folder(drive, fid):
                if f["id"] not in files_by_id:
                    files_by_id[f["id"]] = f
        except Exception as e:
            log_info(log, f"drive: folder {fid} list error: {e}")

    all_files = list(files_by_id.values())
    log_info(log, f"drive: {len(all_files)} unique files found")

    # Gate
    all_ids = [f["id"] for f in all_files]
    stored = fetch_stored_mod_times(all_ids)

    stale_files, skipped_null = [], 0
    for f in all_files:
        s = stored.get(f["id"], _ABSENT)
        if is_stale(f.get("modifiedTime"), s):
            stale_files.append(f)
        elif s is None:
            skipped_null += 1

    log_info(log, f"drive: {len(stale_files)} stale (to embed), "
                  f"{len(all_files) - len(stale_files)} skipped "
                  f"({skipped_null} null-legacy)")

    if limit:
        stale_files = stale_files[:limit]

    if dry_run:
        return {
            "scanned": len(all_files),
            "staged": 0,
            "skipped": len(all_files) - len(stale_files),
            "would_embed": len(stale_files),
            "embed_model": EMBED_MODEL,
            "collection": COLLECTION,
        }

    # Open ChromaDB — same path as local_query.py
    cc = chromadb.PersistentClient(path=CHROMA_PATH)
    col      = cc.get_or_create_collection(COLLECTION,   metadata={"hnsw:space": "cosine"})
    col_sens = cc.get_or_create_collection(COLLECTION_S, metadata={"hnsw:space": "cosine"})

    n_ok = n_fail = n_chunks_total = 0
    kb_source_rows = []

    for f in stale_files:
        mt = f["mimeType"]
        if mt in SKIP_MIME:
            continue

        sensitive = bool(SENSITIVE_RX.search(f.get("name", "")))
        target_col = col_sens if sensitive else col

        wait_for_embed_clear(timeout=90)

        data, ext = download_bytes(drive, f)
        if data is None:
            log_info(log, f"drive: skip unsupported {f['name']} ({mt})")
            continue

        parts = extract_text(data, ext, mt, f["name"])
        if not parts:
            log_info(log, f"drive: no text extracted from {f['name']}, skipping")
            continue

        chunks = [c for p in parts for c in chunk_text(p)]
        chunks = [c for c in chunks if c.strip()][:50]   # cap at 50 per studio_ingest
        if not chunks:
            continue

        base = re.sub(r'[^\w\-. ]', '_', f["name"])[:180]
        try:
            # Remove stale chunks for this file before re-inserting
            try:
                target_col.delete(where={"filename": base})
            except Exception:
                pass

            ids   = [f"{base}#{ci}" for ci in range(len(chunks))]
            metas = [{"filename": base, "type": "text",
                      "chunk_index": ci, "access_scope": "sensitive" if sensitive else "project"}
                     for ci in range(len(chunks))]
            embs  = [embed_bge(c) for c in chunks]

            target_col.add(ids=ids, documents=chunks, metadatas=metas, embeddings=embs)

            n_ok += 1
            n_chunks_total += len(chunks)
            kb_source_rows.append({
                "org_id": ORG_ID,
                "source_type": "drive",
                "drive_file_id": f["id"],
                "staged_basename": base,
                "title": f.get("name"),
                "mime_type": mt,
                "collection": COLLECTION_S if sensitive else COLLECTION,
                "access_scope": "sensitive" if sensitive else "project",
                "file_modified_at": f.get("modifiedTime"),
                "web_view_link": f.get("webViewLink"),
                "parent_folder_id": (f.get("parents") or [None])[0],
                "chunk_count": len(chunks),
                "ingested_at": datetime.datetime.utcnow().isoformat() + "Z",
                "updated_at": datetime.datetime.utcnow().isoformat() + "Z",
            })
            log_info(log, f"drive: embedded {f['name']} ({len(chunks)} chunks) [{COLLECTION_S if sensitive else COLLECTION}]")
            # Flush every 50 files so kb_sources counter increments visibly
            if len(kb_source_rows) >= 50:
                try:
                    supa_upsert("massivlust_kb_sources", ["source_type", "drive_file_id"], kb_source_rows)
                    kb_source_rows = []
                except Exception as flush_err:
                    log_info(log, f"drive: kb_sources flush error (will retry at end): {flush_err}")

        except Exception as e:
            log_info(log, f"drive: embed error {f['name']}: {e}")
            n_fail += 1

    if kb_source_rows:
        supa_upsert("massivlust_kb_sources", ["source_type", "drive_file_id"], kb_source_rows)

    return {
        "scanned": len(all_files),
        "staged": n_ok,
        "failed": n_fail,
        "skipped": len(all_files) - len(stale_files),
        "new_chunks": n_chunks_total,
        "embed_model": EMBED_MODEL,
        "collection": COLLECTION,
    }

# ── Mail sync ────────────────────────────────────────────────────────────────
def sync_mail(dry_run, log):
    if dry_run:
        log_info(log, "mail: dry-run — skipping all pipeline steps")
        return {"harvested": 0, "classified": 0, "embedded": 0, "new_chunks": 0}

    env = {**os.environ, "ML_NEWER_THAN": MAIL_NEWER_THAN}
    node = "/opt/homebrew/bin/node"
    steps = [
        ("harvest",  [node, str(HARVEST_CJS)]),
        ("classify", [node, str(CLASSIFY_CJS)]),
        ("embed",    [str(VENV_PY), str(EMBED_PY)]),
    ]

    stats = {}
    for name, cmd in steps:
        wait_for_embed_clear(timeout=90)
        log_info(log, f"mail: starting {name}")
        try:
            r = subprocess.run(cmd, capture_output=True, text=True, timeout=600, env=env)
            last_line = (r.stdout.strip().splitlines() or [""])[-1]
            stats[name] = last_line[:200]
            if r.returncode != 0:
                log_info(log, f"mail: {name} exit {r.returncode}: {r.stderr[-300:]}")
            else:
                log_info(log, f"mail: {name} done — {last_line[:120]}")
        except subprocess.TimeoutExpired:
            log_info(log, f"mail: {name} timeout")
            stats[name] = "timeout"

    return stats

# ── Logging ──────────────────────────────────────────────────────────────────
def log_info(log_path, msg):
    ts = datetime.datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%SZ")
    entry = {"ts": ts, "msg": msg}
    print(f"[{ts}] {msg}", flush=True)
    try:
        with open(log_path, "a") as f:
            f.write(json.dumps(entry) + "\n")
    except Exception:
        pass

# ── Main ─────────────────────────────────────────────────────────────────────
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true",
                    help="Report gate decisions without embedding")
    ap.add_argument("--skip-drive", action="store_true")
    ap.add_argument("--skip-mail", action="store_true")
    ap.add_argument("--limit", type=int, default=0,
                    help="Max Drive files to embed (0=unlimited)")
    args = ap.parse_args()

    SYNC_DIR.mkdir(parents=True, exist_ok=True)
    today = datetime.date.today().isoformat()
    log = SYNC_DIR / f"{today}.log"

    if PAUSE_FILE.exists():
        print(f"PAUSED — remove {PAUSE_FILE} to resume", flush=True)
        sys.exit(0)

    lock_fd = open(LOCK_FILE, "w")
    try:
        fcntl.flock(lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        print("Another ml-kb-sync instance is running — exiting", flush=True)
        sys.exit(0)

    mode = "DRY-RUN" if args.dry_run else "LIVE"
    log_info(log, f"=== ml-kb-sync START [{mode}] ===")

    t0 = time.time()
    result = {"date": today, "mode": mode, "drive": {}, "mail": {}}

    try:
        if not args.skip_drive:
            log_info(log, "--- Drive part ---")
            result["drive"] = sync_drive(args.dry_run, args.limit, log)
            log_info(log, f"drive result: {result['drive']}")

        if not args.skip_mail:
            log_info(log, "--- Mail part ---")
            result["mail"] = sync_mail(args.dry_run, log)
            log_info(log, f"mail result: {result['mail']}")

    except Exception as e:
        log_info(log, f"FATAL: {e}")
        result["error"] = str(e)
    finally:
        elapsed = round(time.time() - t0, 1)
        result["elapsed_s"] = elapsed
        log_info(log, f"=== ml-kb-sync DONE in {elapsed}s ===")
        with open(log, "a") as f:
            f.write(json.dumps(result) + "\n")
        fcntl.flock(lock_fd, fcntl.LOCK_UN)
        lock_fd.close()


if __name__ == "__main__":
    main()
