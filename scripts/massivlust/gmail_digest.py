#!/usr/bin/env python3
"""Gmail digest for Massivlust — reads new emails, drafts responses via Gemini Flash,
sends formatted notifications to Alex via Telegram.

Usage:
  python3 gmail_digest.py                    # check + notify
  python3 gmail_digest.py --dry-run          # check only, no Telegram
  python3 gmail_digest.py --telegram-chat-id 123456  # override chat ID
"""
import json
import sys
import os
import subprocess
import argparse
from datetime import datetime, timezone
from pathlib import Path
from base64 import urlsafe_b64decode

from google.oauth2 import service_account
from googleapiclient.discovery import build
import google.generativeai as genai

# --- Config ---
KEY_PATH = Path("/Users/max/cortextos/orgs/westside-hq/secrets/wda-fleet-agent-key.json")
TARGET_USER = "alex@massivlust.no"
GMAIL_SCOPES = ["https://www.googleapis.com/auth/gmail.modify"]
STATE_FILE = Path("/Users/max/cortextos/scripts/massivlust/.gmail_digest_state.json")
VAULT_PATH = Path("/Users/max/cortextos/orgs/westside-hq/agents/massivlust-dev/massivlust-vault")

GEMINI_API_KEY = os.environ.get("GEMINI_API_KEY", "")

ALLOWLIST_DOMAINS = [
    "massivtre.as",
    "alvsbyhus.no",
    "massivlust.no",
    "gaus.no",
    "wsaethre.no",
]

ALLOWLIST_ADDRESSES = [
    "post@hammerslaget.no",
    "support@tripletex.no",
]

DENYLIST_SENDERS = [
    "noreply", "no-reply", "mailer-daemon",
    "revolut.com", "temu.com", "airbnb.com", "hybel.no",
    "notifications@", "newsletter@",
]

ALEX_STYLE = """Alex sin skrivestil:
- Kort, uformell, direkte
- Norsk primært
- Signatur: Alexander Lien, 4107 9847
- Emoji brukes av og til
- Tone: profesjonell men vennlig"""


def get_gmail_service():
    creds = service_account.Credentials.from_service_account_file(
        str(KEY_PATH), scopes=GMAIL_SCOPES
    )
    return build("gmail", "v1", credentials=creds.with_subject(TARGET_USER))


def load_state():
    if STATE_FILE.exists():
        return json.loads(STATE_FILE.read_text())
    return {"last_check_epoch": 0, "seen_ids": []}


def save_state(state):
    STATE_FILE.parent.mkdir(parents=True, exist_ok=True)
    STATE_FILE.write_text(json.dumps(state, indent=2))


def extract_email(header_value: str) -> str:
    if "<" in header_value and ">" in header_value:
        return header_value.split("<")[1].split(">")[0].strip()
    return header_value.strip()


def is_allowed(sender_email: str) -> bool:
    email_lower = sender_email.lower()
    for deny in DENYLIST_SENDERS:
        if deny in email_lower:
            return False
    for domain in ALLOWLIST_DOMAINS:
        if email_lower.endswith(f"@{domain}"):
            return True
    for addr in ALLOWLIST_ADDRESSES:
        if email_lower == addr:
            return True
    return False


def get_body_text(payload: dict, max_len: int = 1500) -> str:
    if "parts" in payload:
        for part in payload["parts"]:
            if part.get("mimeType") == "text/plain":
                data = part.get("body", {}).get("data", "")
                if data:
                    return urlsafe_b64decode(data).decode("utf-8", errors="replace")[:max_len]
        for part in payload["parts"]:
            result = get_body_text(part, max_len)
            if result:
                return result
    elif payload.get("mimeType", "").startswith("text/"):
        data = payload.get("body", {}).get("data", "")
        if data:
            return urlsafe_b64decode(data).decode("utf-8", errors="replace")[:max_len]
    return ""


def load_vault_context() -> str:
    context_parts = []
    for fname in ["02-personer/kontaktnett-utkast.md", "05-prosjekter/verksgata-54.md",
                   "05-prosjekter/breivikveien-asker.md", "02-personer/montorer.md"]:
        fp = VAULT_PATH / fname
        if fp.exists():
            content = fp.read_text()[:800]
            context_parts.append(f"--- {fname} ---\n{content}")
    return "\n\n".join(context_parts)


def classify_urgency(subject: str, body: str, labels: list) -> str:
    subject_lower = subject.lower()
    body_lower = body.lower()
    if "IMPORTANT" in labels:
        return "🔴 HASTER"
    if any(w in subject_lower or w in body_lower for w in ["haster", "umiddelbart", "betaling mangler", "frist"]):
        return "🔴 HASTER"
    if any(w in subject_lower or w in body_lower for w in ["tilbud", "kontrakt", "pris", "budsjett", "faktura"]):
        return "🟡 VIKTIG"
    return "🟢 NORMAL"


def draft_response_gemini(email_data: dict, vault_context: str) -> dict:
    genai.configure(api_key=GEMINI_API_KEY)
    model = genai.GenerativeModel("gemini-2.0-flash")

    prompt = f"""Du er Alex Liens AI-assistent for Massiv Lust AS (massivtre-montasje).
Les denne e-posten og gi:
1. En kort oppsummering (maks 2 setninger)
2. Et forslag til svar i Alex sin stil

{ALEX_STYLE}

Kontekst fra bedriften:
{vault_context[:1500]}

E-post:
Fra: {email_data['from']}
Emne: {email_data['subject']}
Dato: {email_data['date']}
Innhold:
{email_data['body'][:1200]}

Svar i dette JSON-formatet (ingen annen tekst):
{{"oppsummering": "...", "foreslatt_svar": "..."}}"""

    try:
        response = model.generate_content(prompt)
        text = response.text.strip()
        if text.startswith("```"):
            text = text.split("\n", 1)[1].rsplit("```", 1)[0].strip()
        return json.loads(text)
    except Exception as e:
        return {
            "oppsummering": f"Kunne ikke analysere automatisk: {str(e)[:100]}",
            "foreslatt_svar": ""
        }


def format_telegram_message(email_data: dict, analysis: dict, urgency: str) -> str:
    sender_name = email_data["from"].split("<")[0].strip().strip('"') if "<" in email_data["from"] else email_data["from_email"]

    msg = f"""{urgency}
📬 *Ny mail fra {sender_name}*
📋 Emne: {email_data['subject']}

📝 {analysis['oppsummering']}"""

    if analysis.get("foreslatt_svar"):
        msg += f"""

✉️ Foreslått svar:
"{analysis['foreslatt_svar']}"

Svar "ok" for å sende, eller skriv eget svar."""

    return msg


def send_telegram(chat_id: str, message: str):
    try:
        subprocess.run(
            ["cortextos", "bus", "send-telegram", chat_id, message],
            capture_output=True, text=True, timeout=10
        )
    except Exception as e:
        print(f"Telegram send failed: {e}", file=sys.stderr)


def fetch_new_emails():
    service = get_gmail_service()
    state = load_state()

    if state["last_check_epoch"] > 0:
        query = f"after:{state['last_check_epoch']} in:inbox"
    else:
        query = "newer_than:1d in:inbox"

    results = service.users().messages().list(
        userId="me", q=query, maxResults=20
    ).execute()

    messages = results.get("messages", [])
    if not messages:
        return [], state

    seen = set(state.get("seen_ids", []))
    new_msgs = [m for m in messages if m["id"] not in seen]

    emails = []
    for msg_meta in new_msgs:
        msg = service.users().messages().get(
            userId="me", id=msg_meta["id"], format="full"
        ).execute()

        headers = {h["name"].lower(): h["value"] for h in msg["payload"].get("headers", [])}
        sender_raw = headers.get("from", "")
        sender_email = extract_email(sender_raw)

        seen.add(msg_meta["id"])

        if not is_allowed(sender_email):
            continue

        emails.append({
            "id": msg_meta["id"],
            "from": sender_raw,
            "from_email": sender_email,
            "subject": headers.get("subject", "(ingen emne)"),
            "date": headers.get("date", ""),
            "body": get_body_text(msg["payload"]),
            "snippet": msg.get("snippet", ""),
            "labels": msg.get("labelIds", []),
        })

    state["last_check_epoch"] = int(datetime.now(timezone.utc).timestamp())
    state["seen_ids"] = list(seen)[-200:]

    return emails, state


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--telegram-chat-id", default=os.environ.get("CTX_TELEGRAM_CHAT_ID", ""))
    args = parser.parse_args()

    if not GEMINI_API_KEY:
        print("ERROR: GEMINI_API_KEY not set", file=sys.stderr)
        sys.exit(1)

    emails, state = fetch_new_emails()

    if not emails:
        print(json.dumps({"status": "no_new_emails", "count": 0}))
        save_state(state)
        return

    vault_context = load_vault_context()

    results = []
    for email in emails:
        urgency = classify_urgency(email["subject"], email["body"], email["labels"])
        analysis = draft_response_gemini(email, vault_context)
        tg_msg = format_telegram_message(email, analysis, urgency)

        results.append({
            "id": email["id"],
            "from": email["from_email"],
            "subject": email["subject"],
            "urgency": urgency,
            "analysis": analysis,
        })

        if not args.dry_run and args.telegram_chat_id:
            send_telegram(args.telegram_chat_id, tg_msg)

        print(tg_msg)
        print("---")

    save_state(state)
    print(json.dumps({"status": "processed", "count": len(results)}, ensure_ascii=False))


if __name__ == "__main__":
    main()
