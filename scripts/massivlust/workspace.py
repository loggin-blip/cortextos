#!/usr/bin/env python3
"""Google Workspace CLI for Jensen — query any @massivlust.no user's Gmail, Drive, Calendar.

Usage:
  workspace.py gmail <email> [--max N]
  workspace.py drive <email> [--folder ID] [--search QUERY]
  workspace.py calendar <email> [--days N]
  workspace.py upload <email> <local_file> <drive_folder_id> [--name <filename>]
  workspace.py find-folder <email> "Parent/Sub/Target"
"""
import argparse
import json
import mimetypes
import os
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

from google.oauth2 import service_account
from googleapiclient.discovery import build
from googleapiclient.http import MediaFileUpload

# Org-wide shared project calendar — always included in calendar queries regardless of user
ORG_PROJECT_CALENDAR = "c_4e6bf11e51bb0f666efcc0b3b4100850fad8ba309564f8d81892dfb29aa7f95f@group.calendar.google.com"

KEY_PATH = Path("/Users/max/cortextos/orgs/westside-hq/secrets/wda-fleet-agent-key.json")
SCOPES = [
    "https://www.googleapis.com/auth/calendar",
    "https://www.googleapis.com/auth/drive",
    "https://www.googleapis.com/auth/gmail.modify",
    "https://www.googleapis.com/auth/documents",
    "https://www.googleapis.com/auth/spreadsheets",
]


def get_service(api: str, version: str, user_email: str):
    creds = service_account.Credentials.from_service_account_file(
        str(KEY_PATH), scopes=SCOPES
    ).with_subject(user_email)
    return build(api, version, credentials=creds)


def cmd_gmail(email: str, max_results: int = 10):
    svc = get_service("gmail", "v1", email)
    res = svc.users().messages().list(userId="me", maxResults=max_results, labelIds=["INBOX"]).execute()
    msgs = res.get("messages", [])
    if not msgs:
        print("Ingen e-post i innboksen.")
        return

    for m in msgs:
        full = svc.users().messages().get(userId="me", id=m["id"], format="metadata",
                                           metadataHeaders=["From", "Subject", "Date"]).execute()
        headers = {h["name"]: h["value"] for h in full.get("payload", {}).get("headers", [])}
        labels = full.get("labelIds", [])
        unread = "UNREAD" in labels
        marker = "*" if unread else " "
        snippet = full.get("snippet", "")[:80]
        print(f"{marker} {headers.get('Date', '?')[:16]}  {headers.get('From', '?')[:30]:30s}  {headers.get('Subject', '(ingen emne)')}")
        if snippet:
            print(f"    {snippet}")


def cmd_drive(email: str, folder_id: str | None = None, search: str | None = None):
    svc = get_service("drive", "v3", email)
    if search:
        escaped = search.replace("'", "\\'")
        q = f"name contains '{escaped}' and trashed = false"
    else:
        parent = folder_id or "root"
        q = f"'{parent}' in parents and trashed = false"

    res = svc.files().list(
        q=q, pageSize=20,
        fields="files(id,name,mimeType,modifiedTime,webViewLink)",
        orderBy="folder,name"
    ).execute()

    files = res.get("files", [])
    if not files:
        print("Ingen filer funnet.")
        return

    for f in files:
        is_folder = f["mimeType"] == "application/vnd.google-apps.folder"
        icon = "📁" if is_folder else "📄"
        mod = f.get("modifiedTime", "")[:10]
        print(f"{icon} {f['name']:40s}  {mod}  {f.get('webViewLink', '')}")


def cmd_calendar(email: str, days: int = 7):
    svc = get_service("calendar", "v3", email)
    now = datetime.now(timezone(timedelta(hours=2)))
    time_min = now.isoformat()
    time_max = (now + timedelta(days=days)).isoformat()

    # Always include the org-wide project calendar directly (not reliant on calendarList)
    # Plus any calendars in the user's calendarList
    cal_list = svc.calendarList().list().execute()
    calendar_ids = list({c["id"] for c in cal_list.get("items", [])})
    if ORG_PROJECT_CALENDAR not in calendar_ids:
        calendar_ids.append(ORG_PROJECT_CALENDAR)
    if not calendar_ids:
        calendar_ids = [email]

    all_events = []
    for cal_id in calendar_ids:
        try:
            res = svc.events().list(
                calendarId=cal_id, timeMin=time_min, timeMax=time_max,
                singleEvents=True, maxResults=50
            ).execute()
            for ev in res.get("items", []):
                ev["_calendarId"] = cal_id
                all_events.append(ev)
        except Exception:
            pass  # Skip calendars we can't read

    if not all_events:
        print(f"Ingen hendelser de neste {days} dagene.")
        return

    def sort_key(ev):
        start = ev.get("start", {})
        return start.get("dateTime", start.get("date", "9999"))

    all_events.sort(key=sort_key)

    for ev in all_events:
        start = ev.get("start", {})
        s = start.get("dateTime", start.get("date", "?"))
        if "T" in s:
            s = s[:16].replace("T", " ")
        summary = ev.get("summary", "(uten tittel)")
        location = ev.get("location", "")
        loc_str = f"  @ {location}" if location else ""
        print(f"  {s}  {summary}{loc_str}")


MIME_MAP = {
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".heic": "image/heic",
    ".pdf": "application/pdf",
    ".doc": "application/msword",
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".xls": "application/vnd.ms-excel",
    ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ".csv": "text/csv",
    ".txt": "text/plain",
    ".mp4": "video/mp4",
    ".mov": "video/quicktime",
}


def guess_mime(filepath: str) -> str:
    ext = os.path.splitext(filepath)[1].lower()
    mime = MIME_MAP.get(ext)
    if mime:
        return mime
    guessed, _ = mimetypes.guess_type(filepath)
    return guessed or "application/octet-stream"


def cmd_upload(email: str, local_file: str, folder_id: str, name: str | None = None):
    if not os.path.isfile(local_file):
        print(f"Feil: filen finnes ikke: {local_file}", file=sys.stderr)
        sys.exit(1)

    upload_name = name or os.path.basename(local_file)
    mime = guess_mime(local_file)

    svc = get_service("drive", "v3", email)
    media = MediaFileUpload(local_file, mimetype=mime, resumable=False)
    metadata = {
        "name": upload_name,
        "parents": [folder_id],
    }
    result = svc.files().create(
        body=metadata,
        media_body=media,
        fields="id,webViewLink",
    ).execute()

    file_id = result["id"]
    link = result.get("webViewLink", f"https://drive.google.com/file/d/{file_id}/view")
    print(f"{file_id}  {link}")


def cmd_find_folder(email: str, path: str):
    svc = get_service("drive", "v3", email)
    parts = [p.strip() for p in path.split("/") if p.strip()]
    if not parts:
        print("Feil: tom mappebane", file=sys.stderr)
        sys.exit(1)

    parent_id = "root"
    for folder_name in parts:
        escaped = folder_name.replace("'", "\\'")
        q = (
            f"name = '{escaped}' "
            f"and '{parent_id}' in parents "
            f"and mimeType = 'application/vnd.google-apps.folder' "
            f"and trashed = false"
        )
        res = svc.files().list(q=q, pageSize=1, fields="files(id)").execute()
        files = res.get("files", [])
        if files:
            parent_id = files[0]["id"]
        else:
            # Create the missing folder
            metadata = {
                "name": folder_name,
                "mimeType": "application/vnd.google-apps.folder",
                "parents": [parent_id],
            }
            created = svc.files().create(body=metadata, fields="id").execute()
            parent_id = created["id"]
            print(f"Opprettet mappe: {folder_name} ({parent_id})", file=sys.stderr)

    print(parent_id)


def main():
    parser = argparse.ArgumentParser(description="Google Workspace for massivlust.no")
    sub = parser.add_subparsers(dest="cmd")

    g = sub.add_parser("gmail")
    g.add_argument("email")
    g.add_argument("--max", type=int, default=10)

    d = sub.add_parser("drive")
    d.add_argument("email")
    d.add_argument("--folder", default=None)
    d.add_argument("--search", default=None)

    c = sub.add_parser("calendar")
    c.add_argument("email")
    c.add_argument("--days", type=int, default=7)

    u = sub.add_parser("upload")
    u.add_argument("email")
    u.add_argument("local_file", help="Path to local file to upload")
    u.add_argument("folder_id", help="Drive folder ID to upload into")
    u.add_argument("--name", default=None, help="Override filename in Drive")

    ff = sub.add_parser("find-folder")
    ff.add_argument("email")
    ff.add_argument("path", help='Slash-separated folder path, e.g. "Massivlust/KS/Tak"')

    args = parser.parse_args()
    if not args.cmd:
        parser.print_help()
        sys.exit(1)

    try:
        if args.cmd == "gmail":
            cmd_gmail(args.email, args.max)
        elif args.cmd == "drive":
            cmd_drive(args.email, args.folder, args.search)
        elif args.cmd == "calendar":
            cmd_calendar(args.email, args.days)
        elif args.cmd == "upload":
            cmd_upload(args.email, args.local_file, args.folder_id, args.name)
        elif args.cmd == "find-folder":
            cmd_find_folder(args.email, args.path)
    except Exception as e:
        print(f"Feil: {e}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
