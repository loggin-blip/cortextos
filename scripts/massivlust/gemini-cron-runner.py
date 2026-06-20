#!/usr/bin/env python3
"""Gemini-powered cron runner for Massivlust operations.

Replaces Claude-powered crons with Gemini 2.5 Flash (free tier, 0 Claude tokens).
Gathers context via cortextos bus CLI, sends to Gemini for decisions,
parses response for actions, executes via bus commands.

Usage:
  python3 gemini-cron-runner.py --cron heartbeat --agent kaptein-massivlust
  python3 gemini-cron-runner.py --cron morgenrapport --agent kaptein-massivlust
  python3 gemini-cron-runner.py --cron dagrapport-trigger --agent kaptein-massivlust
  python3 gemini-cron-runner.py --cron kveldsrapport --agent kaptein-massivlust
"""
import argparse
import json
import os
import re
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

SECRETS_ENV = Path("/Users/max/cortextos/orgs/westside-hq/secrets.env")
GEMINI_MODEL = "gemini-2.5-flash"
GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key={key}"
AGENT_BASE = Path("/Users/max/cortextos/orgs/westside-hq/agents")
ALEX_CHAT_ID = "8672356303"
CORTEXTOS = "cortextos"

LOG_DIR = Path("/Users/max/.cortextos/default/logs/gemini-cron")
LOG_DIR.mkdir(parents=True, exist_ok=True)


def load_api_key() -> str:
    for line in SECRETS_ENV.read_text().splitlines():
        if line.startswith("GEMINI_API_KEY="):
            return line.split("=", 1)[1].strip()
    raise RuntimeError("GEMINI_API_KEY not found in secrets.env")


def bus(args: list[str], timeout: int = 30) -> str:
    result = subprocess.run(
        [CORTEXTOS, "bus"] + args,
        capture_output=True, text=True, timeout=timeout
    )
    return result.stdout.strip()


def bus_run(args: list[str], timeout: int = 30) -> None:
    subprocess.run(
        [CORTEXTOS, "bus"] + args,
        capture_output=True, text=True, timeout=timeout
    )


def read_file(path: str, max_lines: int = 50) -> str:
    try:
        lines = Path(path).read_text().splitlines()[:max_lines]
        return "\n".join(lines)
    except Exception:
        return ""


def call_gemini(prompt: str, api_key: str, system: str = "") -> str:
    """Call Gemini Flash API and return text response."""
    import urllib.request
    import urllib.error

    url = GEMINI_URL.format(model=GEMINI_MODEL, key=api_key)

    contents = [{"role": "user", "parts": [{"text": prompt}]}]
    body = {"contents": contents}
    if system:
        body["systemInstruction"] = {"parts": [{"text": system}]}

    data = json.dumps(body).encode("utf-8")
    req = urllib.request.Request(url, data=data, headers={"Content-Type": "application/json"})

    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            result = json.loads(resp.read())
            return result["candidates"][0]["content"]["parts"][0]["text"]
    except urllib.error.HTTPError as e:
        error_body = e.read().decode("utf-8", errors="replace")[:500]
        raise RuntimeError(f"Gemini API error {e.code}: {error_body}")


def parse_actions(response: str) -> list[dict]:
    """Parse ACTION: lines from Gemini response.
    Handles multi-line messages by collecting lines until the next ACTION: or end."""
    actions = []
    lines = response.splitlines()
    i = 0
    while i < len(lines):
        line = lines[i].strip()
        if line.startswith("ACTION:"):
            cmd = line[7:].strip()
            # For send-telegram/send-message, collect multi-line content
            if cmd.startswith(("send-telegram", "send-message")):
                i += 1
                while i < len(lines):
                    next_line = lines[i].strip()
                    if next_line.startswith("ACTION:"):
                        break
                    cmd += "\n" + lines[i]
                    i += 1
                # Strip trailing quote if present
                cmd = cmd.rstrip().rstrip("'").rstrip('"')
                actions.append({"command": cmd})
                continue
            else:
                actions.append({"command": cmd})
        i += 1
    return actions


SAFE_COMMANDS = ("send-telegram", "send-message", "update-heartbeat",
                 "log-event", "ack-inbox", "update-task", "complete-task")


def execute_actions(actions: list[dict]) -> list[str]:
    """Execute parsed actions via cortextos bus."""
    results = []
    for action in actions:
        cmd = action["command"]
        if not any(cmd.startswith(s) for s in SAFE_COMMANDS):
            results.append(f"SKIPPED (unsafe): {cmd[:80]}")
            continue
        try:
            parts = _split_bus_command(cmd)
            out = bus(parts)
            results.append(f"OK: {cmd[:80]}")
        except Exception as e:
            results.append(f"ERROR: {cmd[:80]} — {e}")
    return results


def _split_bus_command(cmd: str) -> list[str]:
    """Split bus command, handling multi-line message bodies for send-telegram/send-message."""
    if cmd.startswith("send-telegram"):
        match = re.match(r"send-telegram\s+(\S+)\s+'?(.*)", cmd, re.DOTALL)
        if match:
            return ["send-telegram", match.group(1), match.group(2).rstrip("'").strip()]
    elif cmd.startswith("send-message"):
        match = re.match(r"send-message\s+(\S+)\s+(\S+)\s+'?(.*)", cmd, re.DOTALL)
        if match:
            return ["send-message", match.group(1), match.group(2), match.group(3).rstrip("'").strip()]
    import shlex
    return shlex.split(cmd)


# --- CRON: heartbeat ---

def gather_heartbeat_context(agent: str) -> str:
    agent_dir = AGENT_BASE / agent
    inbox = bus(["check-inbox"])
    tasks_ip = bus(["list-tasks", "--status", "in_progress"])
    tasks_pending = bus(["list-tasks", "--status", "pending"])
    heartbeats = bus(["read-all-heartbeats"])
    goals = read_file(str(agent_dir / "GOALS.md"))
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    memory = read_file(str(agent_dir / "memory" / f"{today}.md"))

    return f"""AGENT: {agent}
TIME: {datetime.now(timezone.utc).isoformat()}

INBOX:
{inbox or '(empty)'}

IN-PROGRESS TASKS:
{tasks_ip or '(none)'}

PENDING TASKS:
{tasks_pending or '(none)'}

FLEET HEARTBEATS:
{heartbeats}

GOALS:
{goals or '(no goals set)'}

TODAY'S MEMORY:
{memory or '(no entries yet)'}"""


HEARTBEAT_SYSTEM = """You are kaptein-massivlust, an AI operations coordinator for Massivlust (construction company).
Your job is to run a heartbeat check: update status, process inbox, manage tasks.

Respond with:
1. A brief status summary (1 sentence)
2. Any ACTION: lines to execute

Available actions (prefix each with ACTION:):
- ACTION: update-heartbeat "<status summary>"
- ACTION: log-event heartbeat agent_heartbeat info --meta '{"agent":"kaptein-massivlust"}'
- ACTION: ack-inbox <message_id>
- ACTION: send-message <agent> normal '<message>'
- ACTION: send-telegram 8672356303 '<message to Alex>'
- ACTION: update-task <task_id> in_progress
- ACTION: complete-task <task_id> --result "<summary>"

ALWAYS include these two actions:
- update-heartbeat with current status
- log-event heartbeat

Only send-telegram to Alex for genuinely important items. Do NOT send routine updates."""


def run_heartbeat(agent: str, api_key: str):
    context = gather_heartbeat_context(agent)
    prompt = f"Run heartbeat check. Here is current state:\n\n{context}\n\nProcess inbox, check tasks, update heartbeat."
    response = call_gemini(prompt, api_key, system=HEARTBEAT_SYSTEM)
    actions = parse_actions(response)

    # Always ensure heartbeat update + event log
    has_heartbeat = any("update-heartbeat" in a["command"] for a in actions)
    has_log = any("log-event" in a["command"] for a in actions)
    if not has_heartbeat:
        actions.insert(0, {"command": 'update-heartbeat "gemini-heartbeat: online"'})
    if not has_log:
        actions.append({"command": "log-event heartbeat agent_heartbeat info --meta '{\"agent\":\"kaptein-massivlust\"}'  "})

    results = execute_actions(actions)

    # Write memory entry
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    memory_dir = AGENT_BASE / agent / "memory"
    memory_dir.mkdir(parents=True, exist_ok=True)
    with open(memory_dir / f"{today}.md", "a") as f:
        f.write(f"\n## Gemini Heartbeat - {datetime.now(timezone.utc).strftime('%H:%M UTC')}\n")
        f.write(f"- Actions: {len(actions)}\n")
        for r in results:
            f.write(f"- {r}\n")

    return response, actions, results


# --- CRON: morgenrapport ---

MORGENRAPPORT_SYSTEM = """You are kaptein-massivlust. Build a morning report for Alex (daglig leder, Massivlust).
Language: Norwegian (bokmål). Keep it short and factual.

Report structure:
- Kapasitet i dag: which montører are working, on which projects
- Prosjekt-status: brief per active project
- Ting som krever Alex' oppmerksomhet

Respond with the report text, then ACTION: lines.

Required action:
ACTION: send-telegram 8672356303 '<the full report>'
ACTION: update-heartbeat "morgenrapport sendt"
ACTION: log-event action morgenrapport_sent info --meta '{"agent":"kaptein-massivlust"}'"""


def gather_morgenrapport_context(agent: str) -> str:
    heartbeats = bus(["read-all-heartbeats"])
    tasks_ip = bus(["list-tasks", "--status", "in_progress"])
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    yesterday = (datetime.now(timezone.utc).replace(hour=0) - __import__('datetime').timedelta(days=1)).strftime("%Y-%m-%d")

    # Read recent memory from ML agents
    km_memory = read_file(str(AGENT_BASE / agent / "memory" / f"{today}.md"))
    ml_memory = read_file(str(AGENT_BASE / "ml-prosjektleder" / "memory" / f"{today}.md"))
    jens_memory = read_file(str(AGENT_BASE / "massivlust-team" / "memory" / f"{today}.md"))
    km_yesterday = read_file(str(AGENT_BASE / agent / "memory" / f"{yesterday}.md"), max_lines=30)

    return f"""TIME: {datetime.now(timezone.utc).isoformat()} (Europe/Oslo = UTC+2)

FLEET HEARTBEATS:
{heartbeats}

IN-PROGRESS TASKS:
{tasks_ip}

KAPTEIN-MASSIVLUST TODAY:
{km_memory or '(no entries)'}

KAPTEIN-MASSIVLUST YESTERDAY:
{km_yesterday or '(no entries)'}

ML-PROSJEKTLEDER TODAY:
{ml_memory or '(no entries)'}

MASSIVLUST-TEAM (JENSEN) TODAY:
{jens_memory or '(no entries)'}"""


def run_morgenrapport(agent: str, api_key: str):
    context = gather_morgenrapport_context(agent)
    prompt = f"Build morgenrapport for Alex based on:\n\n{context}"
    response = call_gemini(prompt, api_key, system=MORGENRAPPORT_SYSTEM)
    actions = parse_actions(response)
    results = execute_actions(actions)
    return response, actions, results


# --- CRON: dagrapport-trigger ---

DAGRAPPORT_SYSTEM = """You are kaptein-massivlust. Send a dagrapport-ping to Jensen (massivlust-team agent)
for all active projects. Jensen will then ping each montør for their daily report.

Respond with ACTION: lines only.

Required:
ACTION: send-message massivlust-team normal 'dagrapport-ping: <list active montører and projects>. Ping hver montør for dagrapport.'
ACTION: update-heartbeat "dagrapport-trigger sendt"
ACTION: log-event action dagrapport_trigger_sent info --meta '{"agent":"kaptein-massivlust"}'"""


def gather_dagrapport_context(agent: str) -> str:
    heartbeats = bus(["read-all-heartbeats"])
    tasks_ip = bus(["list-tasks", "--status", "in_progress"])
    jens_memory = read_file(str(AGENT_BASE / "massivlust-team" / "memory" /
                                 datetime.now(timezone.utc).strftime("%Y-%m-%d") + ".md"))
    return f"""TIME: {datetime.now(timezone.utc).isoformat()}
HEARTBEATS:\n{heartbeats}\nTASKS:\n{tasks_ip}\nJENSEN TODAY:\n{jens_memory or '(none)'}"""


def run_dagrapport_trigger(agent: str, api_key: str):
    context = gather_dagrapport_context(agent)
    prompt = f"Send dagrapport-ping. Active state:\n\n{context}"
    response = call_gemini(prompt, api_key, system=DAGRAPPORT_SYSTEM)
    actions = parse_actions(response)
    results = execute_actions(actions)
    return response, actions, results


# --- CRON: kveldsrapport ---

KVELDSRAPPORT_SYSTEM = """You are kaptein-massivlust. Build an evening report for Alex (daglig leder).
Language: Norwegian (bokmål). Short and factual.

Report structure:
- Dagrapporter: summary of what each montør reported today
- Timer: hours logged per person (if available)
- Avvik: any quality/safety issues flagged
- Prosjekt-status: brief per active project
- I morgen: what's planned for tomorrow

Respond with the report text, then ACTION: lines.

Required actions:
ACTION: send-telegram 8672356303 '<the full report>'
ACTION: update-heartbeat "kveldsrapport sendt"
ACTION: log-event action kveldsrapport_sent info --meta '{"agent":"kaptein-massivlust"}'"""


def gather_kveldsrapport_context(agent: str) -> str:
    heartbeats = bus(["read-all-heartbeats"])
    tasks_ip = bus(["list-tasks", "--status", "in_progress"])
    tasks_completed = bus(["list-tasks", "--status", "completed"])
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")

    km_memory = read_file(str(AGENT_BASE / agent / "memory" / f"{today}.md"))
    ml_memory = read_file(str(AGENT_BASE / "ml-prosjektleder" / "memory" / f"{today}.md"))
    jens_memory = read_file(str(AGENT_BASE / "massivlust-team" / "memory" / f"{today}.md"))

    return f"""TIME: {datetime.now(timezone.utc).isoformat()} (Europe/Oslo = UTC+2)

HEARTBEATS:
{heartbeats}

IN-PROGRESS:
{tasks_ip}

COMPLETED (recent):
{tasks_completed[:2000]}

KAPTEIN-MASSIVLUST TODAY:
{km_memory or '(none)'}

ML-PROSJEKTLEDER TODAY:
{ml_memory or '(none)'}

JENSEN TODAY:
{jens_memory or '(none)'}"""


def run_kveldsrapport(agent: str, api_key: str):
    context = gather_kveldsrapport_context(agent)
    prompt = f"Build kveldsrapport for Alex based on:\n\n{context}"
    response = call_gemini(prompt, api_key, system=KVELDSRAPPORT_SYSTEM)
    actions = parse_actions(response)
    results = execute_actions(actions)
    return response, actions, results


# --- Main ---

CRON_RUNNERS = {
    "heartbeat": run_heartbeat,
    "morgenrapport": run_morgenrapport,
    "dagrapport-trigger": run_dagrapport_trigger,
    "kveldsrapport": run_kveldsrapport,
}


def main():
    parser = argparse.ArgumentParser(description="Gemini-powered cron runner for Massivlust")
    parser.add_argument("--cron", required=True, choices=CRON_RUNNERS.keys())
    parser.add_argument("--agent", default="kaptein-massivlust")
    parser.add_argument("--dry-run", action="store_true", help="Print Gemini response without executing actions")
    args = parser.parse_args()

    api_key = load_api_key()
    runner = CRON_RUNNERS[args.cron]

    ts = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")
    log_file = LOG_DIR / f"{args.cron}.log"

    try:
        response, actions, results = runner(args.agent, api_key)

        with open(log_file, "a") as f:
            f.write(f"\n[{ts}] {args.cron} — {len(actions)} actions, {len(results)} results\n")
            for r in results:
                f.write(f"  {r}\n")

        if args.dry_run:
            print("=== GEMINI RESPONSE ===")
            print(response)
            print("\n=== PARSED ACTIONS ===")
            for a in actions:
                print(f"  {a['command']}")
        else:
            print(f"{args.cron}: {len(actions)} actions executed")
            for r in results:
                print(f"  {r}")

    except Exception as e:
        with open(log_file, "a") as f:
            f.write(f"\n[{ts}] {args.cron} ERROR: {e}\n")
        print(f"ERROR: {e}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
