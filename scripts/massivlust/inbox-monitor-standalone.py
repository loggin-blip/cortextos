#!/usr/bin/env python3
"""Standalone inbox monitor — runs gmail_monitor.py and routes actions
without waking any Claude agent. Replaces the kaptein-massivlust crons
for martin@ and alex@ inbox monitoring.

Usage:
  python3 inbox-monitor-standalone.py --user martin@massivlust.no
  python3 inbox-monitor-standalone.py --user alex@massivlust.no
"""
import argparse
import json
import subprocess
import sys
from pathlib import Path

SCRIPTS_DIR = Path(__file__).parent
VENV_PYTHON = str(Path("/Users/max/cortextos/orgs/westside-hq/agents/ml-prosjektleder/scripts/.venv/bin/python3"))
MONITOR_SCRIPT = str(SCRIPTS_DIR / "gmail_monitor.py")
CORTEXTOS = "cortextos"

ALEX_CHAT_ID = "8672356303"


def run_monitor(user: str) -> dict:
    result = subprocess.run(
        [VENV_PYTHON, MONITOR_SCRIPT, "--user", user],
        capture_output=True, text=True, timeout=60
    )
    if result.returncode != 0:
        return {"error": result.stderr or result.stdout, "status": "error"}
    try:
        return json.loads(result.stdout)
    except json.JSONDecodeError:
        return {"error": f"Invalid JSON: {result.stdout[:200]}", "status": "error"}


def bus_cmd(args: list[str]) -> str:
    result = subprocess.run(
        [CORTEXTOS, "bus"] + args,
        capture_output=True, text=True, timeout=30
    )
    return result.stdout.strip()


def handle_martin(emails: list[dict]):
    for email in emails:
        subject = email.get("subject", "")
        from_addr = email.get("from_email", "")
        snippet = email.get("snippet", "")[:80]
        gmail_id = email.get("id", "")

        subject_lower = subject.lower()
        if any(kw in subject_lower for kw in [
            "diplom", "sertifikat", "certificate", "fareblind",
            "farlige mønstre", "farlige monstre", "oppfriskning",
            "signalgiver", "anhuker"
        ]):
            category = "DIPLOM"
        elif "mailer-daemon" in from_addr.lower() or any(
            kw in subject_lower for kw in ["delivery status", "undelivered", "undeliverable", "mail delivery"]
        ):
            category = "BOUNCE"
        else:
            category = "ANNET"

        module = ""
        if "sfs" in subject_lower or "001" in subject_lower:
            module = "SfS001"
        elif "002" in subject_lower:
            module = "SfS002"
        elif "003" in subject_lower:
            module = "SfS003"

        msg = (
            f"martin@-monitor hit: [{category}] | "
            f"mottaker: {from_addr} | "
            f"modul: {module or 'ukjent'} | "
            f"msg-id: {gmail_id} | "
            f"snippet: {snippet}"
        )
        bus_cmd(["send-message", "massivlust-team", "normal", msg])
        print(f"  -> Jensen: {category} from {from_addr}")


def handle_alex(emails: list[dict]):
    for email in emails:
        subject = email.get("subject", "")
        from_addr = email.get("from", "")
        snippet = email.get("snippet", "")[:150]
        category = email.get("category", "general")
        gmail_id = email.get("id", "")
        body_preview = email.get("body_preview", "")[:300]
        attachments = email.get("attachments", [])

        if category == "forespørsel":
            tg_msg = f"NY FORESPØRSEL: {subject} fra {from_addr} — {snippet}. Jeg starter tilbuds-arbeid basert på denne."
            bus_cmd(["send-telegram", ALEX_CHAT_ID, tg_msg])

            dev_msg = (
                f"forespørsel-detected: subject={subject} | from={from_addr} | "
                f"gmail-id={gmail_id} | body_preview={body_preview} | "
                f"attachments={','.join(attachments)}. "
                f"Lag tilbud-draft basert på historiske tilbud (Barlia, Enghave, Mule) "
                f"og per-bil prismodell (massivtre 80-100k/bil, limtre 120-140k/bil). "
                f"Send ferdig draft til kaptein for Alex-relay."
            )
            bus_cmd(["send-message", "massivlust-dev", "high", dev_msg])
            print(f"  -> Alex TG + massivlust-dev: FORESPØRSEL from {from_addr}")

        elif category == "prosjekt":
            tg_msg = f"PROSJEKT-MAIL: {from_addr}: {subject} — {snippet}"
            bus_cmd(["send-telegram", ALEX_CHAT_ID, tg_msg])
            print(f"  -> Alex TG: PROSJEKT from {from_addr}")

        else:
            tg_msg = f"Mail fra {from_addr}: {subject}"
            bus_cmd(["send-telegram", ALEX_CHAT_ID, tg_msg])
            print(f"  -> Alex TG: GENERAL from {from_addr}")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--user", required=True)
    args = parser.parse_args()

    data = run_monitor(args.user)

    if data.get("status") == "error":
        print(f"ERROR: {data.get('error', 'unknown')}", file=sys.stderr)
        sys.exit(1)

    if data.get("status") == "no_new_emails":
        sys.exit(0)

    emails = data.get("emails", [])
    if not emails:
        sys.exit(0)

    print(f"{len(emails)} new email(s) for {args.user}")

    if args.user == "martin@massivlust.no":
        handle_martin(emails)
    elif args.user == "alex@massivlust.no":
        handle_alex(emails)
    else:
        print(f"No handler for {args.user}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
