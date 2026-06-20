#!/usr/bin/env python3
"""Search alex@massivlust.no Gmail via SA impersonation.

Usage:
  python3 gmail_search.py "Roan barnehage"
  python3 gmail_search.py "Gausdal Landhandleri" --max 5
  python3 gmail_search.py "faktura" --user martin@massivlust.no
"""
import sys
import argparse
from datetime import datetime, timezone
from pathlib import Path
from base64 import urlsafe_b64decode

from google.oauth2 import service_account
from googleapiclient.discovery import build

KEY_PATH = Path("/Users/max/cortextos/orgs/westside-hq/secrets/wda-fleet-agent-key.json")
SCOPES = ["https://www.googleapis.com/auth/gmail.modify"]


def get_service(user: str):
    creds = service_account.Credentials.from_service_account_file(
        str(KEY_PATH), scopes=SCOPES
    )
    return build("gmail", "v1", credentials=creds.with_subject(user))


def get_header(headers: list, name: str) -> str:
    for h in headers:
        if h["name"].lower() == name.lower():
            return h["value"]
    return ""


def get_snippet(service, msg_id: str) -> dict:
    msg = service.users().messages().get(
        userId="me", id=msg_id, format="metadata",
        metadataHeaders=["Subject", "From", "Date", "To"]
    ).execute()
    headers = msg.get("payload", {}).get("headers", [])
    ts = int(msg.get("internalDate", 0)) / 1000
    date_str = datetime.fromtimestamp(ts, tz=timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
    return {
        "id": msg_id,
        "date": date_str,
        "from": get_header(headers, "From"),
        "to": get_header(headers, "To"),
        "subject": get_header(headers, "Subject"),
        "snippet": msg.get("snippet", ""),
    }


def search(query: str, user: str, max_results: int):
    service = get_service(user)
    res = service.users().messages().list(
        userId="me", q=query, maxResults=max_results
    ).execute()
    messages = res.get("messages", [])
    if not messages:
        print(f"Ingen treff for: {query!r} ({user})")
        return
    print(f"Fant {len(messages)} treff for: {query!r} ({user})\n{'─'*60}")
    for m in messages:
        info = get_snippet(service, m["id"])
        print(f"[{info['date']}]")
        print(f"  Fra:     {info['from']}")
        print(f"  Til:     {info['to']}")
        print(f"  Emne:    {info['subject']}")
        print(f"  Snippet: {info['snippet'][:200]}")
        print()


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("query", help="Gmail search query")
    parser.add_argument("--max", type=int, default=10, help="Max results (default 10)")
    parser.add_argument("--user", default="alex@massivlust.no", help="Impersonate user")
    args = parser.parse_args()
    search(args.query, args.user, args.max)
