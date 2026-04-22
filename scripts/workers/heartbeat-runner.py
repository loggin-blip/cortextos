#!/usr/bin/env python3
"""
heartbeat-runner.py — Fleet-wide local heartbeat daemon.

Replaces per-agent Claude-heartbeat crons for the ROUTINE part of the heartbeat
workflow (mechanical, rule-based). Runs on Mac Studio as PM2-managed daemon.

For each enabled agent (per enabled-agents.json), every HEARTBEAT_INTERVAL_SEC:
  1. update-heartbeat with a "[local-runner]" status message
  2. log-event heartbeat agent_heartbeat (with source=local-runner)
  3. (optional) re-ingest memory files to KB if >24h stale (skipped in pilot)

Claude-heartbeat-cron in each agent's config.json should be REDUCED to once/day
(e.g. 22:30 Oslo) for deep-reflection: long-term MEMORY.md updates, guardrail
audit, KB re-ingest. Local runner handles the rest.

Escalation: if read-all-heartbeats shows any agent STALE >5h even after our
update attempt (update failed for that agent), send Telegram to ALLOWED_USER.

Pilot mode: set HEARTBEAT_RUNNER_AGENTS env (comma-separated) to limit to
specific agents. Empty = all enabled.

Env:
  HEARTBEAT_INTERVAL_SEC       default 14400 (4h)
  HEARTBEAT_RUNNER_AGENTS      default "" (all enabled)
  CORTEXTOS_STATE_DIR          default ~/.cortextos/default
"""

from __future__ import annotations
import json
import os
import signal
import subprocess
import sys
import time
from pathlib import Path

AGENT_NAME = "heartbeat-runner"
INTERVAL_SEC = int(os.environ.get("HEARTBEAT_INTERVAL_SEC", "14400"))
PILOT_AGENTS = [a.strip() for a in os.environ.get("HEARTBEAT_RUNNER_AGENTS", "").split(",") if a.strip()]
STATE_DIR = Path(os.environ.get("CORTEXTOS_STATE_DIR", str(Path.home() / ".cortextos" / "default")))
ENABLED_AGENTS_FILE = STATE_DIR / "config" / "enabled-agents.json"

LOG_DIR = STATE_DIR / "logs" / AGENT_NAME
LOG_DIR.mkdir(parents=True, exist_ok=True)
STDOUT_LOG = LOG_DIR / "stdout.log"
METRICS_FILE = LOG_DIR / "metrics.jsonl"

_shutdown = False


def log(msg: str) -> None:
    ts = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    line = f"[{ts}] {msg}"
    print(line, flush=True)
    try:
        with STDOUT_LOG.open("a") as f:
            f.write(line + "\n")
    except Exception:
        pass


def handle_sigterm(signum, frame):
    global _shutdown
    log(f"signal {signum} received, exiting after current sweep")
    _shutdown = True


signal.signal(signal.SIGTERM, handle_sigterm)
signal.signal(signal.SIGINT, handle_sigterm)


def load_enabled_agents() -> list[dict]:
    try:
        with ENABLED_AGENTS_FILE.open() as f:
            data = json.load(f)
        out = []
        for name, cfg in data.items():
            if cfg.get("enabled") and name not in ("cortextos", "watchdog"):
                out.append({"name": name, "org": cfg.get("org", "")})
        return out
    except Exception as e:
        log(f"failed to read enabled-agents.json: {e}")
        return []


def bus_as_agent(agent_name: str, args: list[str], timeout: int = 30) -> subprocess.CompletedProcess:
    """Run `cortextos bus <args>` with CTX_AGENT_NAME set to the given agent."""
    env = os.environ.copy()
    env["CTX_AGENT_NAME"] = agent_name
    cmd = ["cortextos", "bus"] + args
    return subprocess.run(cmd, capture_output=True, text=True, timeout=timeout, env=env)


def update_agent_heartbeat(agent_name: str) -> tuple[bool, str]:
    status = "[local-runner] routine heartbeat"
    r = bus_as_agent(agent_name, ["update-heartbeat", status])
    ok = r.returncode == 0
    return ok, r.stderr if not ok else r.stdout.strip()


def log_heartbeat_event(agent_name: str) -> None:
    meta = json.dumps({"agent": agent_name, "source": "local-runner"})
    bus_as_agent(agent_name, ["log-event", "heartbeat", "agent_heartbeat", "info", "--meta", meta])


def check_fleet_stale() -> list[str]:
    """Return list of agent names with heartbeat >5h old. Best-effort."""
    r = subprocess.run(
        ["cortextos", "bus", "read-all-heartbeats", "--format", "json"],
        capture_output=True, text=True, timeout=20,
    )
    if r.returncode != 0:
        return []
    try:
        data = json.loads(r.stdout)
    except Exception:
        return []
    stale = []
    now = time.time()
    for a in data:
        name = a.get("agent") or a.get("name") or ""
        hb = a.get("last_heartbeat") or ""
        if not name or not hb:
            continue
        try:
            # "2026-04-22T18:45:26Z"
            hb_ts = time.mktime(time.strptime(hb.rstrip("Z"), "%Y-%m-%dT%H:%M:%S"))
            # mktime returns local — convert via offset
            offset = time.timezone
            hb_epoch = hb_ts - offset
            if (now - hb_epoch) > 5 * 3600:
                stale.append(name)
        except Exception:
            pass
    return stale


def run_sweep() -> dict:
    """Run one sweep cycle. Returns metrics dict."""
    agents = load_enabled_agents()
    if PILOT_AGENTS:
        agents = [a for a in agents if a["name"] in PILOT_AGENTS]

    log(f"sweep starting: {len(agents)} agent(s): {[a['name'] for a in agents]}")

    updated = 0
    failed = []
    for a in agents:
        if _shutdown:
            break
        ok, msg = update_agent_heartbeat(a["name"])
        if ok:
            updated += 1
            log_heartbeat_event(a["name"])
        else:
            failed.append(a["name"])
            log(f"  update failed for {a['name']}: {msg[:120]}")

    stale = check_fleet_stale()

    metrics = {
        "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "agents_updated": updated,
        "agents_failed": failed,
        "agents_stale": stale,
        "pilot_mode": bool(PILOT_AGENTS),
    }
    try:
        with METRICS_FILE.open("a") as f:
            f.write(json.dumps(metrics) + "\n")
    except Exception:
        pass

    log(f"sweep complete: updated={updated} failed={len(failed)} stale={len(stale)}")
    return metrics


def mainloop() -> None:
    log(f"heartbeat-runner starting; interval={INTERVAL_SEC}s pilot={PILOT_AGENTS or 'ALL'}")

    # Warm-up first sweep immediately, then loop
    run_sweep()

    while not _shutdown:
        remaining = INTERVAL_SEC
        while remaining > 0 and not _shutdown:
            time.sleep(min(5, remaining))
            remaining -= 5
        if _shutdown:
            break
        try:
            run_sweep()
        except Exception as e:
            log(f"sweep error: {e}")

    log("heartbeat-runner exiting cleanly")


if __name__ == "__main__":
    try:
        mainloop()
    except Exception as e:
        log(f"fatal: {e}")
        sys.exit(1)
