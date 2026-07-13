#!/usr/bin/env python3
"""shared-agent-routing — deterministisk lookup mot shared_agents schema.

0 LLM-tokens. Bruker Supabase REST API direkte.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from urllib import request, parse, error


def _env(name: str) -> str:
    val = os.environ.get(name)
    if not val:
        print(f"missing env: {name}", file=sys.stderr)
        sys.exit(2)
    return val


def _rest_get(table_or_view: str, query: str) -> list[dict]:
    url = _env("SUPABASE_URL")
    key = _env("MASSIVLUST_SUPABASE_SERVICE_ROLE_KEY")
    full = f"{url}/rest/v1/{table_or_view}?{query}"
    req = request.Request(
        full,
        headers={
            "apikey": key,
            "Authorization": f"Bearer {key}",
            "Content-Type": "application/json",
        },
    )
    try:
        with request.urlopen(req, timeout=10) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except error.HTTPError as e:
        msg = e.read().decode("utf-8", errors="replace")
        print(f"http error {e.code}: {msg}", file=sys.stderr)
        sys.exit(3)


def list_active(agent: str, role: str | None) -> list[dict]:
    params = {"agent_name": f"eq.{agent}", "select": "*"}
    if role:
        params["role"] = f"eq.{role}"
    return _rest_get("shared_v_active_users", parse.urlencode(params))


def resolve_chat(agent: str, chat_id: str) -> list[dict]:
    params = {
        "agent_name": f"eq.{agent}",
        "telegram_chat_id": f"eq.{chat_id}",
        "select": "*",
    }
    return _rest_get("shared_v_active_users", parse.urlencode(params))


def get_chat_id(agent: str, short_name: str) -> list[dict]:
    params = {
        "agent_name": f"eq.{agent}",
        "short_name": f"eq.{short_name}",
        "select": "short_name,full_name,telegram_chat_id,role",
    }
    return _rest_get("shared_v_active_users", parse.urlencode(params))


def list_projects(short_name: str) -> list[dict]:
    persons = _rest_get(
        "shared_persons",
        parse.urlencode({"short_name": f"eq.{short_name}", "select": "id"}),
    )
    if not persons:
        return []
    person_id = persons[0]["id"]
    return _rest_get(
        "shared_person_projects",
        parse.urlencode(
            {"person_id": f"eq.{person_id}", "active": "eq.true", "select": "*"}
        ),
    )


def project_role(project_id: str, role: str) -> list[dict]:
    rows = _rest_get(
        "shared_person_projects",
        parse.urlencode(
            {
                "project_id": f"eq.{project_id}",
                "role_on_project": f"eq.{role}",
                "active": "eq.true",
                "select": "person_id",
            }
        ),
    )
    if not rows:
        return []
    ids = ",".join(r["person_id"] for r in rows)
    return _rest_get(
        "shared_persons",
        parse.urlencode({"id": f"in.({ids})", "select": "id,short_name,full_name,email"}),
    )


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(prog="lookup")
    sub = parser.add_subparsers(dest="cmd", required=True)

    p = sub.add_parser("list_active")
    p.add_argument("--agent", required=True)
    p.add_argument("--role")

    p = sub.add_parser("resolve_chat")
    p.add_argument("--agent", required=True)
    p.add_argument("--chat-id", required=True)

    p = sub.add_parser("get_chat_id")
    p.add_argument("--agent", required=True)
    p.add_argument("--short-name", required=True)

    p = sub.add_parser("list_projects")
    p.add_argument("--short-name", required=True)

    p = sub.add_parser("project_role")
    p.add_argument("--project-id", required=True)
    p.add_argument("--role", default="pl")

    args = parser.parse_args(argv)

    if args.cmd == "list_active":
        data = list_active(args.agent, args.role)
    elif args.cmd == "resolve_chat":
        data = resolve_chat(args.agent, args.chat_id)
    elif args.cmd == "get_chat_id":
        data = get_chat_id(args.agent, args.short_name)
    elif args.cmd == "list_projects":
        data = list_projects(args.short_name)
    elif args.cmd == "project_role":
        data = project_role(args.project_id, args.role)
    else:
        parser.error("unknown command")

    json.dump({"ok": True, "data": data}, sys.stdout, ensure_ascii=False)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
