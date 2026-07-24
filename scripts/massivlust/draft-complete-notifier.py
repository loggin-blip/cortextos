#!/usr/bin/env python3
"""Standalone draft-complete notifier — polls Supabase for completed mail drafts
and sends DRAFT_COMPLETE to the employee's personal agent via cortextos bus.
Runs every 30s under PM2. Zero Claude tokens.

Usage: python3 draft-complete-notifier.py
"""
import json
import subprocess
import sys
import urllib.request
import urllib.error
from datetime import datetime, timezone, timedelta

ANON_KEY = "sb_publishable_K_ucitW1dHKAiN5wrwgOPQ_W9gU_Nod"
SUPABASE_URL = "https://wnnrtmtgtzcwqobnnzyo.supabase.co/rest/v1"

EMPLOYEE_TO_AGENT = {
    "alex@massivlust.no": "kaptein-massivlust",
    "martin@massivlust.no": "martin-thorvaldsen-venedik",
    "eivind@massivlust.no": "eivind-massivlust",
    "vegard@massivlust.no": "vegard-massivlust",
}


def supabase_get(path: str) -> list:
    req = urllib.request.Request(
        f"{SUPABASE_URL}{path}",
        headers={"apikey": ANON_KEY, "Authorization": f"Bearer {ANON_KEY}"},
    )
    with urllib.request.urlopen(req, timeout=15) as resp:
        return json.loads(resp.read())


def supabase_patch(path: str, data: dict):
    body = json.dumps(data).encode()
    req = urllib.request.Request(
        f"{SUPABASE_URL}{path}",
        data=body,
        method="PATCH",
        headers={
            "apikey": ANON_KEY,
            "Authorization": f"Bearer {ANON_KEY}",
            "Content-Type": "application/json",
        },
    )
    with urllib.request.urlopen(req, timeout=15) as resp:
        return resp.read()


def bus_send(agent: str, body: str):
    subprocess.run(
        ["cortextos", "bus", "send-message", agent, "normal", body],
        capture_output=True, timeout=15,
    )


def run():
    cutoff = (datetime.now(timezone.utc) - timedelta(days=7)).strftime("%Y-%m-%dT%H:%M:%SZ")
    try:
        rows = supabase_get(
            f"/mail_draft_requests?status=eq.completed&agent_notified=eq.false"
            f"&created_at=gte.{cutoff}&select=id,employee_email,thread_id"
        )
    except Exception as e:
        print(f"ERROR fetching from Supabase: {e}", file=sys.stderr)
        return

    for row in rows:
        request_id = row.get("id", "")
        employee = row.get("employee_email", "")
        thread_id = row.get("thread_id", "")
        agent = EMPLOYEE_TO_AGENT.get(employee)

        if not agent:
            # No personal agent for this employee — mark notified to avoid retry loop
            try:
                supabase_patch(f"/mail_draft_requests?id=eq.{request_id}", {"agent_notified": True})
            except Exception:
                pass
            continue

        msg = f"DRAFT_COMPLETE\nrequest_id: {request_id}\nthread_id: {thread_id}\nemployee: {employee}"
        try:
            bus_send(agent, msg)
            supabase_patch(f"/mail_draft_requests?id=eq.{request_id}", {"agent_notified": True})
            ts = datetime.now(timezone.utc).strftime("%H:%M:%S")
            print(f"{ts} DRAFT_COMPLETE → {agent} (request={request_id[:8]})")
        except Exception as e:
            print(f"ERROR notifying {agent}: {e}", file=sys.stderr)


if __name__ == "__main__":
    run()
