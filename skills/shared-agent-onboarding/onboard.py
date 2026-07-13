#!/usr/bin/env python3
"""shared-agent-onboarding — registrer brukere på delte agenter.

Deterministisk. Skriver til persons + agent_memberships ved /start.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from urllib import request, parse, error


def _required(name: str) -> str:
    val = os.environ.get(name)
    if not val:
        print(f"missing env: {name}", file=sys.stderr)
        sys.exit(2)
    return val


def _rest(method: str, path: str, body=None, prefer: str | None = None):
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
        return {"_error": True, "code": e.code, "msg": msg}


def _err(msg: str, **extra) -> int:
    out = {"ok": False, "error": msg}
    out.update(extra)
    print(json.dumps(out, ensure_ascii=False))
    return 1


def cmd_check_chat(args) -> int:
    rows = _rest(
        "GET",
        f"shared_v_active_users?agent_name=eq.{args.agent}&telegram_chat_id=eq.{args.chat_id}",
    )
    if isinstance(rows, dict) and rows.get("_error"):
        return _err(rows["msg"])
    if rows:
        print(json.dumps({"ok": True, "found": True, "data": rows[0]}, ensure_ascii=False))
    else:
        print(json.dumps({"ok": True, "found": False}))
    return 0


def cmd_bind_chat(args) -> int:
    persons = _rest("GET", f"shared_persons?short_name=eq.{args.short_name}&select=id")
    if isinstance(persons, dict) and persons.get("_error"):
        return _err(persons["msg"])
    if not persons:
        return _err(f"unknown short_name: {args.short_name}")
    pid = persons[0]["id"]

    patch = {
        "telegram_chat_id": args.chat_id,
        "telegram_username": args.telegram_username,
        "onboarded_at": "now()",
        "last_seen_at": "now()",
    }
    patch = {k: v for k, v in patch.items() if v is not None}

    result = _rest(
        "PATCH",
        f"shared_agent_memberships?person_id=eq.{pid}&agent_name=eq.{args.agent}",
        body=patch,
        prefer="return=representation",
    )
    if isinstance(result, dict) and result.get("_error"):
        return _err(result["msg"])
    if not result:
        return _err(
            f"no membership found for {args.short_name} on {args.agent} — call create_new first"
        )
    print(json.dumps({"ok": True, "data": result[0]}, ensure_ascii=False))
    return 0


def cmd_create_new(args) -> int:
    existing = _rest("GET", f"shared_persons?short_name=eq.{args.short_name}&select=id")
    if isinstance(existing, dict) and existing.get("_error"):
        return _err(existing["msg"])
    if existing:
        pid = existing[0]["id"]
    else:
        body = {"short_name": args.short_name, "full_name": args.full_name, "email": args.email}
        created = _rest("POST", "shared_persons", body=body, prefer="return=representation")
        if isinstance(created, dict) and created.get("_error"):
            return _err(created["msg"])
        pid = created[0]["id"]

    body = {
        "person_id": pid,
        "agent_name": args.agent,
        "role": args.role,
        "telegram_chat_id": args.chat_id,
        "telegram_username": args.telegram_username,
        "onboarded_at": "now()",
        "last_seen_at": "now()",
    }
    body = {k: v for k, v in body.items() if v is not None}
    created = _rest(
        "POST",
        "shared_agent_memberships",
        body=body,
        prefer="return=representation,resolution=merge-duplicates",
    )
    if isinstance(created, dict) and created.get("_error"):
        return _err(created["msg"])
    print(json.dumps({"ok": True, "person_id": pid, "membership": created[0] if created else None}, ensure_ascii=False))
    return 0


def cmd_list_pending(args) -> int:
    rows = _rest(
        "GET",
        f"shared_agent_memberships?agent_name=eq.{args.agent}&telegram_chat_id=is.null&active=eq.true&select=person_id,role",
    )
    if isinstance(rows, dict) and rows.get("_error"):
        return _err(rows["msg"])
    if not rows:
        print(json.dumps({"ok": True, "data": []}))
        return 0
    ids = ",".join(r["person_id"] for r in rows)
    persons = _rest(
        "GET",
        f"shared_persons?id=in.({ids})&select=id,short_name,full_name,email",
    )
    if isinstance(persons, dict) and persons.get("_error"):
        return _err(persons["msg"])
    person_map = {p["id"]: p for p in persons}
    data = [
        {**person_map.get(r["person_id"], {"id": r["person_id"]}), "role": r["role"]}
        for r in rows
    ]
    print(json.dumps({"ok": True, "data": data}, ensure_ascii=False))
    return 0


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(prog="onboard")
    sub = parser.add_subparsers(dest="cmd", required=True)

    p = sub.add_parser("check_chat")
    p.add_argument("--agent", required=True)
    p.add_argument("--chat-id", required=True)

    p = sub.add_parser("bind_chat")
    p.add_argument("--agent", required=True)
    p.add_argument("--chat-id", required=True)
    p.add_argument("--short-name", required=True)
    p.add_argument("--telegram-username", default=None)

    p = sub.add_parser("create_new")
    p.add_argument("--agent", required=True)
    p.add_argument("--chat-id", required=True)
    p.add_argument("--short-name", required=True)
    p.add_argument("--full-name", required=True)
    p.add_argument("--email", default=None)
    p.add_argument("--role", default="montor")
    p.add_argument("--telegram-username", default=None)

    p = sub.add_parser("list_pending")
    p.add_argument("--agent", required=True)

    args = parser.parse_args(argv)
    if args.cmd == "check_chat":
        return cmd_check_chat(args)
    if args.cmd == "bind_chat":
        return cmd_bind_chat(args)
    if args.cmd == "create_new":
        return cmd_create_new(args)
    if args.cmd == "list_pending":
        return cmd_list_pending(args)
    parser.error("unknown command")
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
