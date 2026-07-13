#!/usr/bin/env python3
"""shared-agent-preflight — go/no-go filter før per-bruker-ping.

Deterministisk. 0 LLM-tokens. Logger til cron_log.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from datetime import datetime, time as dtime, timezone
from urllib import request, parse, error


VACATION_KEYWORDS = ("ferie", "fri", "sykmeldt", "syk", "vacation", "holiday", "permisjon")


def _env(name: str, default: str | None = None) -> str | None:
    return os.environ.get(name, default)


def _required(name: str) -> str:
    val = _env(name)
    if not val:
        print(f"missing env: {name}", file=sys.stderr)
        sys.exit(2)
    return val


def _rest(method: str, path: str, body: dict | None = None, prefer: str | None = None) -> dict | list:
    url = _required("SUPABASE_URL")
    key = _required("MASSIVLUST_SUPABASE_SERVICE_ROLE_KEY")
    headers = {
        "apikey": key,
        "Authorization": f"Bearer {key}",
        "Content-Type": "application/json",
    }
    if prefer:
        headers["Prefer"] = prefer
    data = json.dumps(body).encode("utf-8") if body is not None else None
    req = request.Request(f"{url}/rest/v1/{path}", method=method, data=data, headers=headers)
    try:
        with request.urlopen(req, timeout=10) as resp:
            text = resp.read().decode("utf-8")
            return json.loads(text) if text else {}
    except error.HTTPError as e:
        msg = e.read().decode("utf-8", errors="replace")
        print(f"http error {e.code}: {msg}", file=sys.stderr)
        sys.exit(3)


def _within_quiet_hours(now: datetime, quiet_start: str, quiet_end: str) -> bool:
    """Quiet hours kan krysse midnatt (17:00 - 07:00)."""
    h, m = map(int, quiet_start.split(":")[:2])
    qs = dtime(h, m)
    h, m = map(int, quiet_end.split(":")[:2])
    qe = dtime(h, m)
    n = now.time()
    if qs < qe:
        return qs <= n < qe
    return n >= qs or n < qe


def _check_active(person_id: str, agent: str) -> tuple[bool, str | None]:
    rows = _rest(
        "GET",
        f"shared_v_active_users?person_id=eq.{person_id}&agent_name=eq.{agent}&select=person_id",
    )
    if not rows:
        return False, "inactive"
    return True, None


def _get_quiet_hours(person_id: str, agent: str) -> tuple[str, str, str]:
    rows = _rest(
        "GET",
        f"shared_v_effective_quiet_hours?person_id=eq.{person_id}&agent_name=eq.{agent}",
    )
    if not rows:
        return "17:00", "07:00", "Europe/Oslo"
    r = rows[0]
    return r.get("quiet_start", "17:00"), r.get("quiet_end", "07:00"), r.get("timezone", "Europe/Oslo")


def _check_cooldown(person_id: str, cron_name: str, hours: float) -> tuple[bool, str | None, str | None]:
    q = (
        f"shared_cron_log?person_id=eq.{person_id}&cron_name=eq.{cron_name}"
        f"&outcome=eq.sent&order=fired_at.desc&limit=1&select=fired_at"
    )
    rows = _rest("GET", q)
    if not rows:
        return True, None, None
    last = rows[0]["fired_at"]
    last_dt = datetime.fromisoformat(last.replace("Z", "+00:00"))
    delta_hours = (datetime.now(timezone.utc) - last_dt).total_seconds() / 3600
    if delta_hours < hours:
        return False, "cooldown", last
    return True, None, last


def _check_vacation(person_id: str) -> tuple[bool, str | None]:
    """Returns (ok, reason). Fail-open: if calendar skipped or error, return ok."""
    if _env("GOOGLE_CALENDAR_SKIP") == "1":
        return True, None
    # Real Calendar-call must be done by the agent via Google Calendar MCP.
    # Preflight kan ikke kalle MCP-verktøy direkte fra Python.
    # I praksis: agenten må selv kalle calendar.list_events før preflight.check_vacation_flag,
    # eller passe inn vacation-status. For nå: skip silently (fail-open).
    return True, None


def cmd_check(args: argparse.Namespace) -> int:
    now = datetime.now(timezone.utc)

    ok, reason = _check_active(args.person_id, args.agent)
    if not ok:
        print(json.dumps({"go": False, "reason": reason}))
        return 0

    qs, qe, _tz = _get_quiet_hours(args.person_id, args.agent)
    if _within_quiet_hours(now, qs, qe):
        print(json.dumps({"go": False, "reason": "quiet_hours", "quiet_start": qs, "quiet_end": qe}))
        return 0

    if args.vacation_flag:
        print(json.dumps({"go": False, "reason": "vacation"}))
        return 0

    ok, reason, last = _check_cooldown(args.person_id, args.cron_name, args.cooldown_hours)
    if not ok:
        print(json.dumps({"go": False, "reason": reason, "last_sent_at": last}))
        return 0

    if args.has_items in (False, "false", "False", "0"):
        print(json.dumps({"go": False, "reason": "no_items"}))
        return 0

    print(json.dumps({"go": True, "reason": "ok"}))
    return 0


def cmd_log(args: argparse.Namespace) -> int:
    body = {
        "agent_name": args.agent,
        "cron_name": args.cron_name,
        "person_id": args.person_id,
        "outcome": args.outcome,
        "reason": args.reason,
    }
    if args.metadata:
        body["metadata"] = json.loads(args.metadata)
    _rest("POST", "shared_cron_log", body=body, prefer="return=minimal")
    print(json.dumps({"ok": True}))
    return 0


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(prog="preflight")
    sub = parser.add_subparsers(dest="cmd", required=True)

    p = sub.add_parser("check")
    p.add_argument("--person-id", required=True)
    p.add_argument("--agent", required=True)
    p.add_argument("--cron-name", required=True)
    p.add_argument("--cooldown-hours", type=float, default=4.0)
    p.add_argument("--has-items", default="true")
    p.add_argument(
        "--vacation-flag",
        action="store_true",
        help="Sett hvis caller har sjekket Calendar og fant ferie/fri",
    )

    p = sub.add_parser("log")
    p.add_argument("--person-id", required=True)
    p.add_argument("--agent", required=True)
    p.add_argument("--cron-name", required=True)
    p.add_argument("--outcome", required=True)
    p.add_argument("--reason", default=None)
    p.add_argument("--metadata", default=None)

    args = parser.parse_args(argv)
    if args.cmd == "check":
        return cmd_check(args)
    if args.cmd == "log":
        return cmd_log(args)
    parser.error("unknown command")
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
