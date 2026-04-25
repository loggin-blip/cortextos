#!/usr/bin/env python3
"""Verify Workspace service-account + domain-wide delegation works.

Tests impersonation of alex@massivlust.no via wda-fleet-agent service account.
Run after domain-wide delegation has propagated (5-30 min).
"""
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

from google.oauth2 import service_account
from googleapiclient.discovery import build
from googleapiclient.errors import HttpError

KEY_PATH = Path("/Users/max/cortextos/orgs/westside-hq/secrets/wda-fleet-agent-key.json")
TARGET_USER = "alex@massivlust.no"
SCOPES = [
    "https://www.googleapis.com/auth/calendar",
    "https://www.googleapis.com/auth/drive",
    "https://www.googleapis.com/auth/gmail.modify",
    "https://www.googleapis.com/auth/documents",
    "https://www.googleapis.com/auth/spreadsheets",
]


def get_service(api, version, user):
    creds = service_account.Credentials.from_service_account_file(
        str(KEY_PATH), scopes=SCOPES
    )
    return build(api, version, credentials=creds.with_subject(user))


def test(name):
    def deco(fn):
        def wrapped():
            try:
                fn()
                print(f"  [PASS] {name}")
                return True
            except HttpError as e:
                print(f"  [FAIL] {name}: HTTP {e.resp.status} — {e.reason}")
                if e.resp.status == 403:
                    print("         → Domain-wide delegation ikke propagert eller feil scope/Client ID.")
                return False
            except Exception as e:
                print(f"  [FAIL] {name}: {type(e).__name__}: {e}")
                return False
        return wrapped
    return deco


@test("1. Load service-account credentials")
def t1():
    assert KEY_PATH.exists(), f"Key file mangler: {KEY_PATH}"
    service_account.Credentials.from_service_account_file(str(KEY_PATH), scopes=SCOPES)


@test("2. Impersonate alex@massivlust.no")
def t2():
    svc = get_service("calendar", "v3", TARGET_USER)
    svc.calendarList().list(maxResults=1).execute()


@test("3. List Alex' calendars")
def t3():
    svc = get_service("calendar", "v3", TARGET_USER)
    cals = svc.calendarList().list().execute()
    items = cals.get("items", [])
    print(f"         Fant {len(items)} kalender(e):")
    for c in items[:5]:
        print(f"         - {c.get('summary', '?')} (primary: {c.get('primary', False)})")


@test("4. List next 7 days events")
def t4():
    svc = get_service("calendar", "v3", TARGET_USER)
    now = datetime.now(timezone.utc)
    res = svc.events().list(
        calendarId="primary",
        timeMin=now.isoformat(),
        timeMax=(now + timedelta(days=7)).isoformat(),
        singleEvents=True,
        orderBy="startTime",
        maxResults=5,
    ).execute()
    events = res.get("items", [])
    print(f"         Fant {len(events)} event(s) de neste 7 dagene")


@test("5. Gmail access (labels list)")
def t5():
    svc = get_service("gmail", "v1", TARGET_USER)
    labels = svc.users().labels().list(userId="me").execute()
    print(f"         Fant {len(labels.get('labels', []))} Gmail-labels")


@test("6. Drive access (first 3 files)")
def t6():
    svc = get_service("drive", "v3", TARGET_USER)
    files = svc.files().list(pageSize=3, fields="files(name)").execute()
    print(f"         Fant {len(files.get('files', []))} Drive-filer i første side")


def main():
    print("=" * 60)
    print(f"Test: WDA Workspace service-account for {TARGET_USER}")
    print(f"Key: {KEY_PATH}")
    print("=" * 60)
    results = [t1(), t2(), t3(), t4(), t5(), t6()]
    print("=" * 60)
    passed = sum(results)
    total = len(results)
    if passed == total:
        print(f"ALL PASS ({passed}/{total}). Service-account er klar.")
        sys.exit(0)
    else:
        print(f"{passed}/{total} PASS. Se feil over.")
        print("\nHvis 403-feil: vent 5-30 min på Google-propagering, retry.")
        sys.exit(1)


if __name__ == "__main__":
    main()
