#!/usr/bin/env python3
"""Gmail monitor for Massivlust — multi-mailbox support.

Usage:
  python3 gmail_monitor.py                # default: alex@massivlust.no
  python3 gmail_monitor.py --user martin@massivlust.no
  python3 gmail_monitor.py --user alex@massivlust.no

Per-user config (USER_CONFIGS): allowlist domains, addresses, subject-patterns.
Per-user state-file: .gmail_monitor_state_<user>.json
"""
import argparse
import json
import re
import sys
from datetime import datetime, timezone
from pathlib import Path
from base64 import urlsafe_b64decode

from google.oauth2 import service_account
from googleapiclient.discovery import build

KEY_PATH = Path("/Users/max/cortextos/orgs/westside-hq/secrets/wda-fleet-agent-key.json")
SCOPES = ["https://www.googleapis.com/auth/gmail.modify"]
STATE_DIR = Path("/Users/max/cortextos/scripts/massivlust")

# Per-user monitor-konfigurasjon.
USER_CONFIGS = {
    "alex@massivlust.no": {
        "mode": "read_all",
        "denylist_senders": [
            "temu",
            "hybel.no",
            "xxl.no",
            "newsletter",
            "nyhetsbrev",
            "promo@",
            "marketing@",
            "calendar-notification@google.com",
            "noreply@google.com",
        ],
    },
    "martin@massivlust.no": {
        # Martin = kompetanseansvarlig. Vil fange diplomer (innkommende fra mottakers)
        # + bouncer (mailer-daemon) + SfS-relatert korrespondanse.
        "allowlist_domains": [
            "massivlust.no",      # forwarded diplomer fra @massivlust.no-mottakere
            "muniolms.com",       # SfS001/003 LMS direkte-sending
            "ecoonline.com",      # SfS-via-EcoOnline LMS
            "googlemail.com",     # mailer-daemon bouncer
        ],
        "allowlist_addresses": [],
        "allowlist_subject_patterns": [
            # Diplom/sertifikat-relatert (fanger forward fra privat-mail-mottakere)
            r"diplom",
            r"sertifikat",
            r"certificate",
            r"prosjekt fareblind",
            r"farlige m[øo]nstre",
            r"signalgiver|anhuker",
            r"oppfriskning",
            r"sfs\s*0?0?[123]",
            # Bouncer
            r"delivery status notification",
            r"undelivered|undeliverable",
            r"mail delivery (failed|subsystem)",
        ],
        "denylist_senders": [
            "noreply",
            "no-reply",
        ],
    },
}


def get_gmail_service(target_user: str):
    creds = service_account.Credentials.from_service_account_file(
        str(KEY_PATH), scopes=SCOPES
    )
    return build("gmail", "v1", credentials=creds.with_subject(target_user))


def state_file_for(target_user: str) -> Path:
    safe = target_user.replace("@", "_at_").replace(".", "_")
    return STATE_DIR / f".gmail_monitor_state_{safe}.json"


def load_state(target_user: str):
    sf = state_file_for(target_user)
    if sf.exists():
        return json.loads(sf.read_text())
    # Backwards-compat: hvis vi monitorer alex@ og det finnes legacy .gmail_monitor_state.json, bruk den.
    if target_user == "alex@massivlust.no":
        legacy = STATE_DIR / ".gmail_monitor_state.json"
        if legacy.exists():
            return json.loads(legacy.read_text())
    return {"last_check_epoch": 0, "seen_ids": []}


def save_state(target_user: str, state):
    sf = state_file_for(target_user)
    sf.parent.mkdir(parents=True, exist_ok=True)
    sf.write_text(json.dumps(state, indent=2))


def is_allowed(sender_email: str, subject: str, config: dict) -> bool:
    email_lower = sender_email.lower()

    if config.get("mode") == "read_all":
        for deny in config.get("denylist_senders", []):
            if deny in email_lower:
                return False
        return True

    subject_lower = subject.lower()

    for deny in config.get("denylist_senders", []):
        if deny in email_lower:
            return False

    for domain in config.get("allowlist_domains", []):
        if email_lower.endswith(f"@{domain}") or email_lower.endswith(f".{domain}"):
            return True

    for addr in config.get("allowlist_addresses", []):
        if email_lower == addr:
            return True

    for pattern in config.get("allowlist_subject_patterns", []):
        if re.search(pattern, subject_lower, re.IGNORECASE):
            return True

    return False


FORESPØRSEL_PATTERNS = [
    r"forespørsel\s+montasje",
    r"tilbud\s+montasje",
    r"pris\s+(på\s+)?montasje",
    r"prise?\s+(opp|dette)",
    r"montasje.*massivtre",
    r"montasje.*limtre",
    r"montasje.*klt",
    r"antall\s+biler",
    r"ifc.modell",
    r"\.ifc\b",
]


def classify_email(subject: str, body: str, attachments: list[str]) -> str:
    """Classify email: forespørsel, prosjekt, or general."""
    text = f"{subject} {body}".lower()
    has_ifc = any(a.lower().endswith(".ifc") for a in attachments)
    forespørsel_hits = sum(1 for p in FORESPØRSEL_PATTERNS if re.search(p, text, re.IGNORECASE))
    if has_ifc or forespørsel_hits >= 2:
        return "forespørsel"
    project_keywords = [
        r"prosjekt", r"byggeplass", r"montasje", r"leveranse",
        r"fremdrift", r"kjøreplan", r"oppstart", r"element",
        r"massivtre", r"limtre", r"klt\b", r"splitkon", r"veidekke",
    ]
    if sum(1 for p in project_keywords if re.search(p, text, re.IGNORECASE)) >= 2:
        return "prosjekt"
    return "general"


def extract_email(header_value: str) -> str:
    if "<" in header_value and ">" in header_value:
        return header_value.split("<")[1].split(">")[0].strip()
    return header_value.strip()


def get_body_snippet(payload: dict, max_len: int = 500) -> str:
    if "parts" in payload:
        for part in payload["parts"]:
            if part.get("mimeType") == "text/plain":
                data = part.get("body", {}).get("data", "")
                if data:
                    text = urlsafe_b64decode(data).decode("utf-8", errors="replace")
                    return text[:max_len]
        for part in payload["parts"]:
            result = get_body_snippet(part, max_len)
            if result:
                return result
    elif payload.get("mimeType", "").startswith("text/"):
        data = payload.get("body", {}).get("data", "")
        if data:
            text = urlsafe_b64decode(data).decode("utf-8", errors="replace")
            return text[:max_len]
    return ""


def check_new_emails(target_user: str):
    if target_user not in USER_CONFIGS:
        raise ValueError(f"Ingen konfigurasjon for {target_user}. Legg til i USER_CONFIGS.")
    config = USER_CONFIGS[target_user]
    service = get_gmail_service(target_user)
    state = load_state(target_user)

    if state["last_check_epoch"] > 0:
        query = f"after:{state['last_check_epoch']}"
    else:
        query = "newer_than:1d"

    results = service.users().messages().list(
        userId="me", q=query, maxResults=50
    ).execute()

    messages = results.get("messages", [])
    if not messages:
        state["last_check_epoch"] = int(datetime.now(timezone.utc).timestamp())
        save_state(target_user, state)
        return []

    seen = set(state.get("seen_ids", []))
    new_msgs = [m for m in messages if m["id"] not in seen]

    if not new_msgs:
        state["last_check_epoch"] = int(datetime.now(timezone.utc).timestamp())
        save_state(target_user, state)
        return []

    alerts = []
    for msg_meta in new_msgs:
        msg = service.users().messages().get(
            userId="me", id=msg_meta["id"], format="full"
        ).execute()

        headers = {h["name"].lower(): h["value"] for h in msg["payload"].get("headers", [])}
        sender_raw = headers.get("from", "")
        sender_email = extract_email(sender_raw)
        subject = headers.get("subject", "(no subject)")
        date = headers.get("date", "")

        seen.add(msg_meta["id"])

        # Skip egen utgående mail (SENT-label uten INBOX-label = ren outbound).
        labels = msg.get("labelIds", [])
        if "SENT" in labels and "INBOX" not in labels:
            continue

        # Skip Gmail-kategorisert marketing/social/updates (system-notifikasjoner).
        SKIP_CATEGORIES = {"CATEGORY_PROMOTIONS", "CATEGORY_SOCIAL", "CATEGORY_UPDATES", "CATEGORY_FORUMS"}
        if SKIP_CATEGORIES.intersection(labels):
            continue

        if not is_allowed(sender_email, subject, config):
            continue

        body_snippet = get_body_snippet(msg["payload"])

        attachment_names = []
        def find_attachments(part):
            fn = part.get("filename", "")
            if fn and not fn.startswith("image"):
                attachment_names.append(fn)
            for sub in part.get("parts", []):
                find_attachments(sub)
        find_attachments(msg["payload"])

        category = classify_email(subject, body_snippet, attachment_names)

        alerts.append({
            "mailbox": target_user,
            "id": msg_meta["id"],
            "from": sender_raw,
            "from_email": sender_email,
            "subject": subject,
            "date": date,
            "snippet": msg.get("snippet", ""),
            "body_preview": body_snippet[:300],
            "labels": msg.get("labelIds", []),
            "category": category,
            "attachments": attachment_names,
        })

    state["last_check_epoch"] = int(datetime.now(timezone.utc).timestamp())
    state["seen_ids"] = list(seen)[-200:]
    save_state(target_user, state)

    return alerts


def main():
    parser = argparse.ArgumentParser(description="Multi-mailbox Gmail monitor for Massivlust")
    parser.add_argument(
        "--user",
        default="alex@massivlust.no",
        help="Mailbox to monitor (default: alex@massivlust.no). Must exist in USER_CONFIGS.",
    )
    args = parser.parse_args()

    try:
        alerts = check_new_emails(args.user)
    except Exception as e:
        print(json.dumps({"error": str(e), "user": args.user}))
        sys.exit(1)

    if not alerts:
        print(json.dumps({"status": "no_new_emails", "user": args.user, "count": 0}))
        return

    print(json.dumps(
        {"status": "new_emails", "user": args.user, "count": len(alerts), "emails": alerts},
        indent=2,
        ensure_ascii=False,
    ))


if __name__ == "__main__":
    main()
