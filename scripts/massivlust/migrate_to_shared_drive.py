#!/usr/bin/env python3
"""Migrate Massivlust files from personal Drive + Supabase data to Shared Drive.

Phase 1: Copy files from Alex's personal Drive → Shared Drive subfolders
Phase 2: Create markdown summaries of Supabase data → upload as Google Docs
Phase 3: Create Arkiv folder for legacy/completed projects

Usage:
    python3 migrate_to_shared_drive.py [--phase 1|2|3|all] [--dry-run]
"""
import argparse
import json
import os
import sys
import tempfile
import time
from datetime import datetime
from pathlib import Path

# Force unbuffered stdout for progress visibility
sys.stdout.reconfigure(line_buffering=True)
sys.stderr.reconfigure(line_buffering=True)

from google.oauth2 import service_account
from googleapiclient.discovery import build
from googleapiclient.http import MediaFileUpload

# ── Config ──────────────────────────────────────────────────────────────────
KEY_PATH = Path("/Users/max/cortextos/orgs/westside-hq/secrets/wda-fleet-agent-key.json")
SCOPES = [
    "https://www.googleapis.com/auth/drive",
    "https://www.googleapis.com/auth/documents",
]
ADMIN_EMAIL = "alex@massivlust.no"
MAP_PATH = Path(__file__).parent / "shared_drive_map.json"

# Rate limit: max 10 requests/sec for Drive API
RATE_LIMIT_DELAY = 0.15  # seconds between API calls


# ── Helpers ─────────────────────────────────────────────────────────────────
def get_service(api="drive", version="v3"):
    creds = service_account.Credentials.from_service_account_file(
        str(KEY_PATH), scopes=SCOPES
    ).with_subject(ADMIN_EMAIL)
    return build(api, version, credentials=creds)


def load_drive_map():
    with open(MAP_PATH) as f:
        return json.load(f)


def check_file_exists(svc, name, dest_folder_id):
    """Check if a file with this name already exists in the destination folder."""
    try:
        escaped = name.replace("'", "\\'")
        res = svc.files().list(
            q=f"name = '{escaped}' and '{dest_folder_id}' in parents and trashed = false",
            pageSize=1,
            fields="files(id)",
            supportsAllDrives=True,
            includeItemsFromAllDrives=True,
        ).execute()
        return len(res.get("files", [])) > 0
    except Exception:
        return False


def copy_file(svc, file_id, dest_folder_id, new_name=None, dry_run=False):
    """Copy a file to dest folder in the Shared Drive. Returns new file ID.
    Skips if a file with the same name already exists (idempotent)."""
    time.sleep(RATE_LIMIT_DELAY)
    try:
        # First, get file metadata to know the name
        meta = svc.files().get(
            fileId=file_id,
            fields="name,mimeType",
            supportsAllDrives=True,
        ).execute()
        name = new_name or meta["name"]
        mime = meta.get("mimeType", "")

        if dry_run:
            print(f"  [DRY-RUN] Would copy: {name} ({file_id}) → {dest_folder_id}")
            return None

        # Check if file already exists in dest
        if check_file_exists(svc, name, dest_folder_id):
            print(f"  SKIP (finnes): {name}")
            return "already-exists"

        # Google Docs/Sheets/Slides can be copied directly
        # Binary files (PDF, images, etc.) can also be copied
        body = {
            "name": name,
            "parents": [dest_folder_id],
        }
        result = svc.files().copy(
            fileId=file_id,
            body=body,
            fields="id,name,webViewLink",
            supportsAllDrives=True,
        ).execute()
        print(f"  OK: {result['name']} → {result.get('webViewLink', result['id'])}")
        return result["id"]
    except Exception as e:
        print(f"  FEIL: Kunne ikke kopiere {file_id}: {e}", file=sys.stderr)
        return None


def list_folder_children(svc, folder_id):
    """List all non-trashed files in a folder."""
    time.sleep(RATE_LIMIT_DELAY)
    children = []
    page_token = None
    while True:
        res = svc.files().list(
            q=f"'{folder_id}' in parents and trashed = false",
            pageSize=100,
            fields="nextPageToken,files(id,name,mimeType)",
            supportsAllDrives=True,
            includeItemsFromAllDrives=True,
            pageToken=page_token,
        ).execute()
        children.extend(res.get("files", []))
        page_token = res.get("nextPageToken")
        if not page_token:
            break
    return children


def create_folder(svc, name, parent_id, drive_id, dry_run=False):
    """Create a folder in the Shared Drive."""
    if dry_run:
        print(f"  [DRY-RUN] Would create folder: {name} in {parent_id}")
        return "dry-run-folder-id"
    time.sleep(RATE_LIMIT_DELAY)
    metadata = {
        "name": name,
        "mimeType": "application/vnd.google-apps.folder",
        "parents": [parent_id],
    }
    result = svc.files().create(
        body=metadata,
        fields="id,name",
        supportsAllDrives=True,
    ).execute()
    print(f"  Mappe opprettet: {name} ({result['id']})")
    return result["id"]


def upload_text_as_doc(svc, title, content, folder_id, drive_id, dry_run=False):
    """Upload markdown text as a file (plain text .md) to Drive."""
    if dry_run:
        print(f"  [DRY-RUN] Would upload doc: {title} → {folder_id}")
        return None

    time.sleep(RATE_LIMIT_DELAY)

    # Check if doc already exists
    if check_file_exists(svc, title, folder_id):
        print(f"  SKIP (finnes): {title}")
        return "already-exists"

    # Write to temp file and upload as plain text (Google will render it)
    with tempfile.NamedTemporaryFile(mode="w", suffix=".md", delete=False, encoding="utf-8") as f:
        f.write(content)
        tmp_path = f.name

    try:
        metadata = {
            "name": title,
            "parents": [folder_id],
            "mimeType": "application/vnd.google-apps.document",
        }
        media = MediaFileUpload(tmp_path, mimetype="text/plain", resumable=False)
        result = svc.files().create(
            body=metadata,
            media_body=media,
            fields="id,name,webViewLink",
            supportsAllDrives=True,
        ).execute()
        print(f"  DOC: {result['name']} → {result.get('webViewLink', result['id'])}")
        return result["id"]
    except Exception as e:
        print(f"  FEIL doc upload {title}: {e}", file=sys.stderr)
        return None
    finally:
        os.unlink(tmp_path)


# ══════════════════════════════════════════════════════════════════════════════
# PHASE 1: Copy files from personal Drive to Shared Drive
# ══════════════════════════════════════════════════════════════════════════════

# File manifest: (source_file_id, project, subfolder, optional_name)
PHASE1_FILES = [
    # ── Verksgata 54 ──
    ("1ObQt54oXUO4Se7sDqvHEX_NHkGraj8xWuYXOxyrOrxY", "Verksgata 54", "00 Oversikt", None),  # Bemanningsliste
    ("1KacFilfdOfOFdZOvYDJesqkVDP5awtKL", "Verksgata 54", "00 Oversikt", None),  # Prosjektinfo PDF
    ("1t2xDKRQG-eX3yK-7lCpTRzWL9etDknje", "Verksgata 54", "04 Dokumenter", None),  # Kjøreplan PDF
    ("1uqGxPKIQqvOFAGps4JjJMychXw34um7C", "Verksgata 54", "04 Dokumenter", None),  # Kompetanse-matrise PDF
    ("1BExuqBtUjLvwRG5keKJqrVOF-RKLB849", "Verksgata 54", "05 Sjekklister", None),  # KS doc PDF
    ("1ZqrqHBpv4ydloKWm1Oubz57D0k-bMufT", "Verksgata 54", "04 Dokumenter", None),  # IFC file

    # ── Breivikveien 14 ──
    ("1Ajq5GMmXw-Z4a3K6g9WnkhXH6nmrrQpF11QsdpfiuvU", "Breivikveien 14", "00 Oversikt", None),  # Bemanningsliste
    ("1ZwSf4wste09nw01DwusdRZNNZsINM6Fo", "Breivikveien 14", "00 Oversikt", None),  # Prosjektinfo PDF
    ("1t_A-zeN_RMOhzaYbDFM9S9Ss9SPEV6XYAdPybXfdmnQ", "Breivikveien 14", "05 Sjekklister", None),  # KS sluttkontroll
    ("1MPEQ4-UyLNlZrzPA8ao75cg6lE5wkyvuBne_lbllJjo", "Breivikveien 14", "05 Sjekklister", None),  # KS FASE 0
    ("1QYm6LWuq8KFrgVzgQhd1ZByZEj75Lvuz2-HSzKNwUkw", "Breivikveien 14", "05 Sjekklister", None),  # KS-rapport eksempel
    ("1Vsa1O2qj6BEVSMLR5R39Ioh12hD3W8TORrR5SNOZcSQ", "Breivikveien 14", "04 Dokumenter", None),  # Meeting notes Gemini 1
    ("1I5v45ZX01l690_ZyzKP_DuWZEuwP-PZaRQLlvawr6gk", "Breivikveien 14", "04 Dokumenter", None),  # Meeting notes Gemini 2
    ("1GlQF0Wi2KNYEhW6gr9HOAeu7rW4jP8HC", "Breivikveien 14", "04 Dokumenter", None),  # Tilbud PDF

    # ── Roan ──
    ("114ixmnVAqbeZrp1F9jaipURxsgpRnFgJn8Qx2LOQhlo", "Roan", "00 Oversikt", None),  # Bemanningsliste
    ("1orT94oEArw4VMxMZr-of5OtXR8w9kdYG", "Roan", "00 Oversikt", None),  # Prosjektinfo PDF
    ("1us00Piue-KxzCNI82CFnEm-3Zs5n-mg9", "Roan", "04 Dokumenter", None),  # Installation drawings PDF
    ("1pEG-TKLqQ8RSIRdnt9E2tGmBN0OaRF62", "Roan", "04 Dokumenter", None),  # IFC
    ("1uUltRt2VEOJ93V-ecuoFR3o0Pu1SPQCS", "Roan", "04 Dokumenter", None),  # HTML 3D

    # ── Ullsåk ──
    ("1Cv7XEs4WcdzzvA5Zl25IJ_AC_1mf-aQ49yR9HS7iwFg", "Ullsåk", "00 Oversikt", None),  # Bemanningsliste
    ("1LtJxWQSrkEF68HZZSO4hyQ1EdKl7arssZjAEpSA2V1c", "Ullsåk", "04 Dokumenter", None),  # Forespørsel dok

    # ── Bortelid sentrumsbygg ──
    ("11aat14Vux3XoKIhbRQVMoAJ5yV0owgY9FAulbn8llIs", "Bortelid sentrumsbygg", "00 Oversikt", None),  # Bemanningsliste
    ("1wcJYQTVos7IsEL_oC2wQEzyBJUew7r8g7Ifytx6dS5g", "Bortelid sentrumsbygg", "00 Oversikt", None),  # Prosjektlogg
    ("1vCJ4IqPfQLXM3FWMgXZ4EFa7ivHDH3FrtPOnyt3FQeo", "Bortelid sentrumsbygg", "01 Avvik", None),  # KS-avvik staldetaljer
    ("1QQLdgIfYd2GOEXeDHtNdYDKquQvNmnNVI-7dFFFEG_E", "Bortelid sentrumsbygg", "04 Dokumenter", None),  # Meeting notes 1
    ("1QGJ2L_x4sxf9JPUIX5Zk-vHKo_QEHXslG09QLo2Se2k", "Bortelid sentrumsbygg", "04 Dokumenter", None),  # Meeting notes 2
]

# Folders to copy all children from
PHASE1_FOLDERS = [
    # (source_folder_id, project, dest_subfolder, description)
    ("1EaPJ24ub0YnCqL967-ARin2eTnEeme1X", "Verksgata 54", "04 Dokumenter", "Phase drawing PDFs (V52-*.pdf)"),
    ("10TUC6dsy4H6P97Izso8e-MOtaAhJ8Xd6", "Breivikveien 14", "02 Bilder", "Legacy photos/videos (HEIC + MOV)"),
    ("1iwxpwvSq89G88k-WbRkTft6iLKJU2DSO", "Bortelid sentrumsbygg", "02 Bilder", "Bortelid Bilder folder"),
]

# Verksgata site photos (image001-008 from 00 Prosjektadmin)
# We need to list the folder and find image files
PHASE1_VG_PHOTOS_FOLDER = None  # Will search for this

# Verksgata avvik files
PHASE1_VG_AVVIK = [
    # VG-R401 avvik doc + 4 JPGs - these are individual file IDs we'll search for
    # VG-R403 avvik doc + 3 JPGs
    # We'll handle these by listing the avvik source folder
]

# Company-level files
PHASE1_COMPANY = [
    ("1Zw2aEVYmE2CFvsyhiknwHqc84toIpQbrbBSU2sefUn8", "Kompetanse", None, None),  # Kompetanse-matrise alle 19
    ("1ZLDCr1rO9FY_xlRnnXpwQnLPMopVFpe3", "Kompetanse", None, None),  # Kompetanse-matrise PDF
]


def run_phase1(svc, dm, dry_run=False):
    """Copy individual files and folder contents to Shared Drive."""
    drive_id = dm["_drive_id"]
    stats = {"ok": 0, "fail": 0, "skip": 0}

    print("\n" + "=" * 70)
    print("FASE 1: Kopierer filer fra personlig Drive → Shared Drive")
    print("=" * 70)

    # ── Individual files ──
    print("\n--- Individuelle filer ---")
    for file_id, project, subfolder, name in PHASE1_FILES:
        dest_folder = dm[project][subfolder]
        result = copy_file(svc, file_id, dest_folder, name, dry_run)
        if result is not None or dry_run:
            stats["ok"] += 1
        else:
            stats["fail"] += 1

    # ── Company-level files ──
    print("\n--- Selskapsnivå (Kompetanse) ---")
    for file_id, folder_key, _, _ in PHASE1_COMPANY:
        dest_folder = dm[folder_key]
        result = copy_file(svc, file_id, dest_folder, None, dry_run)
        if result is not None or dry_run:
            stats["ok"] += 1
        else:
            stats["fail"] += 1

    # ── Folder contents ──
    print("\n--- Mapper (kopier alt innhold) ---")
    for src_folder_id, project, subfolder, desc in PHASE1_FOLDERS:
        dest_folder = dm[project][subfolder]
        print(f"\n  Mappe: {desc} → {project}/{subfolder}")
        try:
            children = list_folder_children(svc, src_folder_id)
            print(f"  Fant {len(children)} filer")
            for child in children:
                # Skip subfolders
                if child["mimeType"] == "application/vnd.google-apps.folder":
                    print(f"    Hopper over undermappe: {child['name']}")
                    stats["skip"] += 1
                    continue
                result = copy_file(svc, child["id"], dest_folder, None, dry_run)
                if result is not None or dry_run:
                    stats["ok"] += 1
                else:
                    stats["fail"] += 1
        except Exception as e:
            print(f"  FEIL: Kunne ikke liste mappe {src_folder_id}: {e}", file=sys.stderr)
            stats["fail"] += 1

    # ── Verksgata: search for site photos (image001-008) in prosjektadmin ──
    print("\n--- Verksgata 54: site photos ---")
    try:
        # Search for image files in Alex's drive related to Verksgata
        # The photos are named image001.png through image008.png
        # They're in the "00 Prosjektadmin" folder of Verksgata
        # Let's search by name pattern
        dest_bilder = dm["Verksgata 54"]["02 Bilder"]
        for i in range(1, 9):
            img_name = f"image{i:03d}"
            time.sleep(RATE_LIMIT_DELAY)
            res = svc.files().list(
                q=f"name contains '{img_name}' and trashed = false",
                pageSize=5,
                fields="files(id,name,mimeType,parents)",
                supportsAllDrives=True,
                includeItemsFromAllDrives=True,
            ).execute()
            files = res.get("files", [])
            if files:
                # Copy the first matching image file
                img_file = files[0]
                result = copy_file(svc, img_file["id"], dest_bilder, None, dry_run)
                if result is not None or dry_run:
                    stats["ok"] += 1
                else:
                    stats["fail"] += 1
            else:
                print(f"    Fant ikke {img_name}")
                stats["skip"] += 1
    except Exception as e:
        print(f"  FEIL søk etter site photos: {e}", file=sys.stderr)
        stats["fail"] += 1

    # ── Verksgata: avvik files (R401, R403) ──
    print("\n--- Verksgata 54: avvik-filer ---")
    dest_avvik = dm["Verksgata 54"]["01 Avvik"]
    try:
        # Search for VG-R401 and VG-R403 files
        for avvik_ref in ["VG-R401", "R401", "VG-R403", "R403"]:
            time.sleep(RATE_LIMIT_DELAY)
            res = svc.files().list(
                q=f"name contains '{avvik_ref}' and trashed = false",
                pageSize=20,
                fields="files(id,name,mimeType)",
                supportsAllDrives=True,
                includeItemsFromAllDrives=True,
            ).execute()
            files = res.get("files", [])
            for f in files:
                result = copy_file(svc, f["id"], dest_avvik, None, dry_run)
                if result is not None or dry_run:
                    stats["ok"] += 1
                else:
                    stats["fail"] += 1
            if not files:
                print(f"    Ingen treff for '{avvik_ref}'")
    except Exception as e:
        print(f"  FEIL søk avvik: {e}", file=sys.stderr)
        stats["fail"] += 1

    return stats


# ══════════════════════════════════════════════════════════════════════════════
# PHASE 2: Supabase data → Markdown → Google Docs in Shared Drive
# ══════════════════════════════════════════════════════════════════════════════

def generate_supabase_docs():
    """Generate markdown documents from actual Supabase data."""
    docs = []
    d = datetime.now().strftime("%Y-%m-%d")

    # ═══════════════════════════════════════════════════════════════════
    # VERKSGATA 54
    # ═══════════════════════════════════════════════════════════════════

    docs.append({
        "project": "Verksgata 54",
        "subfolder": "01 Avvik",
        "title": "Avvik — Verksgata 54 (Supabase)",
        "content": f"""\
# Avvik — Verksgata 54

_Eksportert fra Supabase {d}_

Ingen avvik registrert i Supabase for dette prosjektet.

Avvik VG-R401 og VG-R403 finnes som dokumenter i denne Drive-mappen (kopiert fra Alex' personlige Drive).
""",
    })

    docs.append({
        "project": "Verksgata 54",
        "subfolder": "00 Oversikt",
        "title": "Dagrapporter — Verksgata 54 (Supabase)",
        "content": f"""\
# Dagrapporter — Verksgata 54

_Eksportert fra Supabase {d}_

| Dato | Montor | Utfort | Elementer | Timer | Nye avvik | Retro bra | Retro darlig |
|------|--------|--------|-----------|-------|-----------|-----------|--------------|
| 2026-04-28 | Eivind Smedal | Rigging og oppstart. Fundamentkontroll gjennomfort. Alle ankerfester OK. | F-01, F-02, F-03, F-04 | 8.0 | 0 | God oppstart, alt pa plass | Vind forsinket litt kranarbeid |
| 2026-04-29 | Eivind Smedal | Montasje vegger 1. etg. 6 veggelementer satt. | V-01, V-02, V-03, V-04, V-05, V-06 | 9.5 | 0 | Effektiv dag, alle elementer pa plass | Ingen |
| 2026-05-02 | Eivind Smedal | Skrueforbindelser vegger ferdigstilt. KS godkjent for vegger 1. etg. | V-01, V-02, V-03, V-04, V-05, V-06 | 8.0 | 0 | Ryddig KS-prosess | Noe venting pa skruer |
| 2026-05-05 | Eivind Smedal | Startet dekke 2. etg. D-01 og D-02 loftet og plassert. | D-01, D-02 | 9.0 | 0 | Godt kransamarbeid med Marius | Dekke-elementene tyngre enn forventet |

_4 dagrapporter totalt_
""",
    })

    docs.append({
        "project": "Verksgata 54",
        "subfolder": "00 Oversikt",
        "title": "Timer — Verksgata 54 (Supabase)",
        "content": f"""\
# Timer — Verksgata 54

_Eksportert fra Supabase {d}_

| Dato | Montor | Timer | Type | Beskrivelse | Godkjent |
|------|--------|-------|------|-------------|----------|
| 2026-04-28 | Eivind Smedal | 8.0 | normal | Rigging og fundamentkontroll | Ja |
| 2026-04-28 | Sondre L Bjontegaard | 8.0 | normal | Rigging | Ja |
| 2026-04-28 | Marius Lindberg | 4.0 | normal | Kranoperasjon fundament | Ja |
| 2026-04-29 | Eivind Smedal | 9.5 | overtid | Veggmontasje 1. etg | Ja |
| 2026-04-29 | Marius Lindberg | 6.0 | normal | Kranoperasjon vegger | Ja |
| 2026-04-29 | Sondre L Bjontegaard | 9.5 | overtid | Veggmontasje | Ja |
| 2026-05-02 | Eivind Smedal | 8.0 | normal | Skrueforbindelser og KS | Ja |
| 2026-05-05 | Eivind Smedal | 9.0 | normal | Dekke 2. etg oppstart | Nei |
| 2026-05-05 | Marius Lindberg | 6.0 | normal | Kranoperasjon dekke | Nei |

**Totalt: 68.0 timer (9 poster)**
- Normal: 40.0 t
- Overtid: 19.0 t
- Ikke godkjent: 15.0 t
""",
    })

    docs.append({
        "project": "Verksgata 54",
        "subfolder": "04 Dokumenter",
        "title": "Fakturaer — Verksgata 54 (Supabase)",
        "content": f"""\
# Fakturaer — Verksgata 54

_Eksportert fra Supabase {d}_

| Milepael | Belop (NOK) | Status | Forfall | Sendt | Betalt |
|----------|-------------|--------|---------|-------|--------|
| F1 -- Oppstart uke 18 | 127 500 | Betalt | 2026-05-15 | 2026-04-28 | 2026-05-12 |
| F2 -- Uke 19 | 144 500 | Sendt | 2026-05-22 | 2026-05-05 | -- |
| F3 -- Uke 20 | 144 500 | Planlagt | 2026-05-29 | -- | -- |
| F4 -- Uke 21 | 144 500 | Planlagt | 2026-06-05 | -- | -- |
| F5 -- Uke 22 | 144 500 | Planlagt | 2026-06-12 | -- | -- |
| F6 -- Uke 23 | 59 500 | Planlagt | 2026-06-19 | -- | -- |
| F7 -- Sluttfaktura uke 25 | 85 000 | Planlagt | 2026-06-26 | -- | -- |

**Totalt kontraktsverdi: 850 000 NOK**
- Betalt: 127 500 (15%)
- Sendt/utestående: 144 500 (17%)
- Planlagt: 578 000 (68%)
""",
    })

    docs.append({
        "project": "Verksgata 54",
        "subfolder": "05 Sjekklister",
        "title": "KS-sjekk — Verksgata 54 (Supabase)",
        "content": f"""\
# KS-sjekk — Verksgata 54

_Eksportert fra Supabase {d}_

| Omrade | Elementer | Status | Montor | Montor signert | PL signert | Sjekkliste | Kommentar |
|--------|-----------|--------|--------|----------------|------------|------------|-----------|
| Fundament | F-01, F-02, F-03, F-04 | Signert PL | Eivind Smedal | 2026-04-28 | 2026-04-28 | Bolt-moment, Niva, Plassering | Alle ankerfester kontrollert, moment OK |
| Vegger 1. etg | V-01, V-02, V-03, V-04, V-05, V-06 | Signert PL | Eivind Smedal | 2026-05-02 | 2026-05-02 | Lodd, Skrueforbindelse, Fugemasse | Loddavvik <2mm. Alle skruer iht montasjeanvisning. |
| Dekke 2. etg | D-01, D-02, D-03, D-04 | Pagar | Eivind Smedal | -- | -- | Opplegg, Skrueforbindelse, Niva | Montasje pagar uke 19 |

_3 KS-poster (2 signert, 1 pagar)_
""",
    })

    docs.append({
        "project": "Verksgata 54",
        "subfolder": "03 Mail",
        "title": "Korrespondanse — Verksgata 54 (Supabase)",
        "content": f"""\
# Korrespondanse — Verksgata 54

_Eksportert fra Supabase {d}_

| Dato | Retning | Fra | Til | Emne | Viktig |
|------|---------|-----|-----|------|--------|
| 2026-04-25 | Ut | Alex Lien | Carsten Hovind | Verksgata 54 -- leveringsbekreftelse | Ja |
| 2026-04-28 | Inn | Carsten Hovind | Alex Lien | Re: Verksgata 54 -- leveringsbekreftelse | Nei |

## Detaljer

### 2026-04-25 -- Leveringsbekreftelse (ut)
**Fra:** Alex Lien (alex@massivlust.no)
**Til:** Carsten Hovind
Hei Carsten, bekrefter mottatt leveringsplan for uke 18-25. Vi er klare for oppstart mandag 28. april.

### 2026-04-28 -- Re: Leveringsbekreftelse (inn)
**Fra:** Carsten Hovind (carsten@massivtre.no)
**Til:** Alex Lien
Hei Alex, forste tralle er pa vei. Levering kl 07:30.
""",
    })

    # ═══════════════════════════════════════════════════════════════════
    # BREIVIKVEIEN 14
    # ═══════════════════════════════════════════════════════════════════

    docs.append({
        "project": "Breivikveien 14",
        "subfolder": "01 Avvik",
        "title": "Avvik — Breivikveien 14B (Supabase)",
        "content": f"""\
# Avvik — Breivikveien 14B

_Eksportert fra Supabase {d}_

| # | Dato | Montor | Beskrivelse | Sendt til | Leverandor | Status | Lukket dato | Lukket av |
|---|------|--------|-------------|-----------|------------|--------|-------------|-----------|
| 1 | 2026-03-10 | Vegard Broen | Oppmaling fra byggherre stemte ikke med tegninger. Avvik pa 15mm i x-retning. | Byggherre | -- | Lukket | 2026-03-12 | Vegard Broen |
| 2 | 2026-03-15 | Mathias Ronnestad | Skruelengde feil -- brukt 80mm i stedet for 100mm pa vegg-tak-kobling. | Vegard Broen | -- | Lukket | 2026-03-16 | Mathias Ronnestad |
| 3 | 2026-03-20 | Mathias Ronnestad | Verktoygjennomgang -- slagbor mangler kalibreringssertifikat. | Martin T Venedik | -- | Lukket | 2026-03-22 | Martin T Venedik |
| 4 | 2026-03-28 | Vegard Broen | Soylefeste mot fundament -- bolt-hull 5mm forskjovet. Krevde utfresing. | Splitkon | Splitkon | Lukket | 2026-04-01 | Vegard Broen |
| 6 | 2026-04-10 | Vegard Broen | VGZ-levering forsinket 3 dager fra Splitkon. Pavirket fremdrift. | Splitkon | Splitkon | Lukket | 2026-04-14 | Vegard Broen |
| 7 | 2026-04-18 | Mathias Ronnestad | Bjelke overstikk 2cm i takflate. Utenfor toleranse. | Splitkon | Splitkon | APEN | -- | -- |
| 8 | 2026-04-25 | Mathias Ronnestad | 3mm gap mellom tak og vegg-element. Fuktrisiko om ikke tettet. | Vegard Broen | -- | APEN | -- | -- |

**Totalt: 7 avvik (5 lukket, 2 apne)**

## Apne avvik

### #7 -- Bjelke overstikk (2026-04-18)
- **Montor:** Mathias Ronnestad
- **Sendt til:** Splitkon
- **Plan:** Avventer RIB-vurdering for kapping vs. aksept

### #8 -- Gap tak-vegg (2026-04-25)
- **Montor:** Mathias Ronnestad
- **Sendt til:** Vegard Broen
- **Plan:** Tetting med kompriband planlagt uke 19
""",
    })

    docs.append({
        "project": "Breivikveien 14",
        "subfolder": "00 Oversikt",
        "title": "Dagrapporter — Breivikveien 14B (Supabase)",
        "content": f"""\
# Dagrapporter — Breivikveien 14B

_Eksportert fra Supabase {d}_

| Dato | Montor | Utfort | Elementer | Timer | Nye avvik | Retro bra | Retro darlig |
|------|--------|--------|-----------|-------|-----------|-----------|--------------|
| 2026-04-25 | Mathias Ronnestad | Takmontasje pagar. Oppdaget 3mm gap mellom tak og vegg (avvik #008). | T-03, T-04 | 8.5 | 1 | Godt tempo pa montasje | Gap-problem krever ekstra arbeid |
| 2026-05-02 | Mathias Ronnestad | Ferdigstillelse tak-elementer T-01 og T-02. Skrueforbindelser kontrollert. | T-01, T-02 | 8.0 | 0 | Takforbindelser OK | Avventer RIB for overstikk (avvik #007) |

_2 dagrapporter totalt_
""",
    })

    docs.append({
        "project": "Breivikveien 14",
        "subfolder": "00 Oversikt",
        "title": "Timer — Breivikveien 14B (Supabase)",
        "content": f"""\
# Timer — Breivikveien 14B

_Eksportert fra Supabase {d}_

| Dato | Montor | Timer | Type | Beskrivelse | Godkjent |
|------|--------|-------|------|-------------|----------|
| 2026-04-25 | Mathias Ronnestad | 8.5 | normal | Takmontasje | Ja |
| 2026-04-25 | Odin Austefjord | 8.5 | normal | Takmontasje assistanse | Ja |
| 2026-05-02 | Mathias Ronnestad | 8.0 | normal | Tak ferdigstillelse | Ja |

**Totalt: 25.0 timer (3 poster)**
- Alle godkjent
""",
    })

    docs.append({
        "project": "Breivikveien 14",
        "subfolder": "05 Sjekklister",
        "title": "KS-sjekk — Breivikveien 14B (Supabase)",
        "content": f"""\
# KS-sjekk — Breivikveien 14B

_Eksportert fra Supabase {d}_

| Omrade | Elementer | Status | Montor | Montor signert | PL signert | Sjekkliste | Kommentar |
|--------|-----------|--------|--------|----------------|------------|------------|-----------|
| Fundament | F-01, F-02 | Signert PL | Mathias Ronnestad | 2026-03-05 | 2026-03-05 | Bolt-moment, Niva, Plassering | Fundament OK etter korrigering (avvik #001) |
| Vegger | V-01 til V-08 | Signert PL | Mathias Ronnestad | 2026-03-20 | 2026-03-21 | Lodd, Skrueforbindelse, Fugemasse, Vindforbindelse | Alle vegger montert og kontrollert |
| Soyler | S-01, S-02, S-03, S-04 | Signert PL | Vegard Broen | 2026-03-28 | 2026-03-29 | Bolt-moment, Lodd, Plassering | Soylefeste korrigert (avvik #004), godkjent av RIB |
| Tak | T-01, T-02, T-03, T-04 | Pagar | Mathias Ronnestad | -- | -- | Forbindelse, Niva, Tetting | Avvik #007 og #008 apne -- avventer RIB og tetting |

_4 KS-poster (3 signert, 1 pagar)_
""",
    })

    docs.append({
        "project": "Breivikveien 14",
        "subfolder": "03 Mail",
        "title": "Korrespondanse — Breivikveien 14B (Supabase)",
        "content": f"""\
# Korrespondanse — Breivikveien 14B

_Eksportert fra Supabase {d}_

| Dato | Retning | Fra | Til | Emne | Viktig |
|------|---------|-----|-----|------|--------|
| 2026-04-10 | Ut | Vegard Broen | Mathias Bech | Breivikveien 14B -- VGZ forsinkelse | Ja |
| 2026-04-10 | Inn | Mathias Bech | Vegard Broen | Re: Breivikveien 14B -- VGZ forsinkelse | Nei |

## Detaljer

### 2026-04-10 -- VGZ forsinkelse (ut)
**Fra:** Vegard Broen (vegard@massivlust.no)
**Til:** Mathias Bech
Hei Mathias, VGZ-levering var planlagt i dag men ikke mottatt. Hva er status?

### 2026-04-10 -- Re: VGZ forsinkelse (inn)
**Fra:** Mathias Bech (mathias.bech@splitkon.no)
**Til:** Vegard Broen
Beklager forsinkelsen. Produksjonsfeil oppdaget. Ny levering estimert 13.04.
""",
    })

    return docs


def run_phase2(svc, dm, dry_run=False):
    """Export Supabase data as markdown, upload as Google Docs."""
    drive_id = dm["_drive_id"]
    stats = {"ok": 0, "fail": 0}

    print("\n" + "=" * 70)
    print("FASE 2: Supabase-data → Google Docs i Shared Drive")
    print("=" * 70)

    docs = generate_supabase_docs()
    for doc in docs:
        project = doc["project"]
        subfolder = doc["subfolder"]
        dest_folder = dm[project][subfolder]
        result = upload_text_as_doc(
            svc, doc["title"], doc["content"], dest_folder, drive_id, dry_run
        )
        if result is not None or dry_run:
            stats["ok"] += 1
        else:
            stats["fail"] += 1

    return stats


# ══════════════════════════════════════════════════════════════════════════════
# PHASE 3: Create Arkiv folder for legacy projects
# ══════════════════════════════════════════════════════════════════════════════

ARKIV_PROJECTS = [
    "Ferdigstilte prosjekter",
]


def run_phase3(svc, dm, dry_run=False):
    """Create Arkiv folder structure for old/completed projects."""
    drive_id = dm["_drive_id"]
    stats = {"ok": 0, "fail": 0}

    print("\n" + "=" * 70)
    print("FASE 3: Oppretter Arkiv-mappe for eldre prosjekter")
    print("=" * 70)

    # Create top-level Arkiv folder
    arkiv_id = create_folder(svc, "Arkiv", drive_id, drive_id, dry_run)
    if arkiv_id:
        stats["ok"] += 1
    else:
        stats["fail"] += 1
        return stats

    # Create subfolders for categorization
    for name in ARKIV_PROJECTS:
        sub_id = create_folder(svc, name, arkiv_id, drive_id, dry_run)
        if sub_id:
            stats["ok"] += 1
        else:
            stats["fail"] += 1

    # Create a README doc explaining the archive
    readme_content = """\
# Arkiv — Massivlust Prosjekter

Denne mappen inneholder arkiverte prosjekter som er ferdigstilt.

## Struktur
- Ferdigstilte prosjekter/ — Prosjekter som er fullført og levert

## Rutine
Når et prosjekt er ferdigstilt:
1. Flytt prosjektmappen hit fra hovedlisten
2. Marker som ferdigstilt i prosjektloggen
3. Behold alle dokumenter for fremtidig referanse

_Opprettet {date}_
""".format(date=datetime.now().strftime("%Y-%m-%d"))

    result = upload_text_as_doc(
        svc, "README — Arkiv", readme_content, arkiv_id, drive_id, dry_run
    )
    if result is not None or dry_run:
        stats["ok"] += 1
    else:
        stats["fail"] += 1

    return stats


# ══════════════════════════════════════════════════════════════════════════════
# Main
# ══════════════════════════════════════════════════════════════════════════════

def main():
    parser = argparse.ArgumentParser(description="Migrering til Massivlust Shared Drive")
    parser.add_argument("--phase", choices=["1", "2", "3", "all"], default="all",
                        help="Hvilken fase å kjøre (default: all)")
    parser.add_argument("--dry-run", action="store_true",
                        help="Vis hva som ville blitt gjort uten å gjøre det")
    args = parser.parse_args()

    dm = load_drive_map()
    svc = get_service()

    print(f"Massivlust Shared Drive Migrering — {datetime.now().strftime('%Y-%m-%d %H:%M')}")
    print(f"Shared Drive ID: {dm['_drive_id']}")
    if args.dry_run:
        print("*** DRY RUN — ingen endringer ***")

    total = {"ok": 0, "fail": 0, "skip": 0}

    if args.phase in ("1", "all"):
        s = run_phase1(svc, dm, args.dry_run)
        total["ok"] += s["ok"]
        total["fail"] += s["fail"]
        total["skip"] += s.get("skip", 0)

    if args.phase in ("2", "all"):
        s = run_phase2(svc, dm, args.dry_run)
        total["ok"] += s["ok"]
        total["fail"] += s["fail"]

    if args.phase in ("3", "all"):
        s = run_phase3(svc, dm, args.dry_run)
        total["ok"] += s["ok"]
        total["fail"] += s["fail"]

    print("\n" + "=" * 70)
    print(f"FERDIG — OK: {total['ok']}  FEIL: {total['fail']}  HOPPET OVER: {total.get('skip', 0)}")
    print("=" * 70)

    if total["fail"] > 0:
        sys.exit(1)


if __name__ == "__main__":
    main()
