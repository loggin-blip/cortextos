#!/usr/bin/env python3
"""
approvals-runner.py — Fleet-wide approval + human-task safety-scan daemon.

Every APPROVALS_INTERVAL_SEC (default 2h):
  1. list-approvals → ping user via Telegram if any pending >1h
  2. list-tasks --project human-tasks --status pending → ping if >4h
  3. log cron_completed event

Replaces the per-agent `check-approvals` Claude-cron for routine scanning.
Claude only wakes if user replies to a ping (normal inbox flow).

Env:
  APPROVALS_INTERVAL_SEC    default 7200 (2h)
  TELEGRAM_CHAT_ID          REQUIRED — from agent .env
  TELEGRAM_BOT_TOKEN        REQUIRED — from agent .env (kaptein bot used)
  CORTEXTOS_STATE_DIR       default ~/.cortextos/default
"""

from __future__ import annotations
import json
import os
import signal
import subprocess
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path

AGENT_NAME = "approvals-runner"
INTERVAL_SEC = int(os.environ.get("APPROVALS_INTERVAL_SEC", "7200"))
STATE_DIR = Path(os.environ.get("CORTEXTOS_STATE_DIR", str(Path.home() / ".cortextos" / "default")))
TELEGRAM_CHAT_ID = os.environ.get("TELEGRAM_CHAT_ID", "")
TELEGRAM_BOT_TOKEN = os.environ.get("TELEGRAM_BOT_TOKEN", "")

LOG_DIR = STATE_DIR / "logs" / AGENT_NAME
LOG_DIR.mkdir(parents=True, exist_ok=True)
STDOUT_LOG = LOG_DIR / "stdout.log"
METRICS_FILE = LOG_DIR / "metrics.jsonl"
# Persistent ping-tracking: so we don't re-ping same approval every 2h
PINGED_FILE = LOG_DIR / "pinged.json"

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
    log(f"signal {signum} received, draining then exiting")
    _shutdown = True


signal.signal(signal.SIGTERM, handle_sigterm)
signal.signal(signal.SIGINT, handle_sigterm)


def load_pinged() -> dict:
    try:
        with PINGED_FILE.open() as f:
            return json.load(f)
    except Exception:
        return {}


def save_pinged(pinged: dict) -> None:
    try:
        with PINGED_FILE.open("w") as f:
            json.dump(pinged, f)
    except Exception as e:
        log(f"save_pinged failed: {e}")


def bus(args: list[str], timeout: int = 30) -> subprocess.CompletedProcess:
    return subprocess.run(["cortextos", "bus"] + args, capture_output=True, text=True, timeout=timeout)


def send_telegram(text: str) -> bool:
    if not TELEGRAM_CHAT_ID or not TELEGRAM_BOT_TOKEN:
        log("WARN: TELEGRAM_CHAT_ID or BOT_TOKEN missing — cannot send ping")
        return False
    url = f"https://api.telegram.org/bot{TELEGRAM_BOT_TOKEN}/sendMessage"
    data = urllib.parse.urlencode({
        "chat_id": TELEGRAM_CHAT_ID,
        "text": text,
    }).encode()
    try:
        req = urllib.request.Request(url, data=data)
        with urllib.request.urlopen(req, timeout=10) as r:
            r.read()
        return True
    except Exception as e:
        log(f"Telegram send failed: {e}")
        return False


def iso_to_epoch(s: str) -> float | None:
    if not s:
        return None
    try:
        t = time.mktime(time.strptime(s.rstrip("Z"), "%Y-%m-%dT%H:%M:%S"))
        return t - time.timezone
    except Exception:
        return None


def scan_approvals(pinged: dict) -> tuple[int, int]:
    """Return (approvals_found, pings_sent)."""
    r = bus(["list-approvals", "--status", "pending", "--format", "json"])
    if r.returncode != 0 or not r.stdout.strip():
        return (0, 0)
    try:
        data = json.loads(r.stdout)
    except Exception:
        return (0, 0)
    if not isinstance(data, list):
        return (0, 0)

    now = time.time()
    pings = 0
    for ap in data:
        ap_id = ap.get("id") or ap.get("approval_id") or ""
        if not ap_id:
            continue
        created = iso_to_epoch(ap.get("created_at") or ap.get("createdAt") or "")
        if created is None:
            continue
        age_hours = (now - created) / 3600
        if age_hours < 1:
            continue
        last_pinged = pinged.get(f"approval_{ap_id}", 0)
        if (now - last_pinged) < 3600:
            continue  # re-ping max 1x/hour per approval
        title = ap.get("title", "(no title)")[:80]
        msg = f"⏰ Approval pending {age_hours:.1f}h: {title} — sjekk dashboard"
        if send_telegram(msg):
            pinged[f"approval_{ap_id}"] = now
            pings += 1
            log(f"pinged approval {ap_id} ({age_hours:.1f}h old)")
    return (len(data), pings)


def scan_human_tasks(pinged: dict) -> tuple[int, int]:
    """Return (tasks_found, pings_sent)."""
    r = bus(["list-tasks", "--status", "pending", "--format", "json"])
    if r.returncode != 0:
        return (0, 0)
    try:
        data = json.loads(r.stdout)
    except Exception:
        return (0, 0)
    human_tasks = [t for t in data if (t.get("project") == "human-tasks"
                                       or str(t.get("title", "")).startswith("[HUMAN]"))]

    now = time.time()
    pings = 0
    for t in human_tasks:
        t_id = t.get("id", "")
        if not t_id:
            continue
        created = iso_to_epoch(t.get("created_at") or t.get("createdAt") or "")
        if created is None:
            continue
        age_hours = (now - created) / 3600
        if age_hours < 4:
            continue
        last_pinged = pinged.get(f"human_task_{t_id}", 0)
        if (now - last_pinged) < 4 * 3600:
            continue  # re-ping max 1x/4hr per task
        title = t.get("title", "(no title)")[:80]
        msg = f"👤 [HUMAN] task venter {age_hours:.1f}h: {title}"
        if send_telegram(msg):
            pinged[f"human_task_{t_id}"] = now
            pings += 1
            log(f"pinged human-task {t_id} ({age_hours:.1f}h old)")
    return (len(human_tasks), pings)


def log_event(approvals_count: int, human_tasks_count: int, pings: int) -> None:
    meta = json.dumps({
        "cron": "check-approvals",
        "approvals": approvals_count,
        "human_tasks": human_tasks_count,
        "pings": pings,
        "source": "local-runner",
    })
    env = os.environ.copy()
    env["CTX_AGENT_NAME"] = env.get("CTX_AGENT_NAME", "kaptein")
    subprocess.run(
        ["cortextos", "bus", "log-event", "action", "cron_completed", "info", "--meta", meta],
        capture_output=True, text=True, timeout=15, env=env,
    )


def run_sweep() -> None:
    pinged = load_pinged()
    ap_count, ap_pings = scan_approvals(pinged)
    ht_count, ht_pings = scan_human_tasks(pinged)
    save_pinged(pinged)
    total_pings = ap_pings + ht_pings
    log(f"sweep: approvals={ap_count} human_tasks={ht_count} pings_sent={total_pings}")
    log_event(ap_count, ht_count, total_pings)

    metrics = {
        "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "approvals_pending": ap_count,
        "human_tasks_pending": ht_count,
        "pings_sent": total_pings,
    }
    try:
        with METRICS_FILE.open("a") as f:
            f.write(json.dumps(metrics) + "\n")
    except Exception:
        pass


def mainloop() -> None:
    log(f"approvals-runner starting; interval={INTERVAL_SEC}s")
    if not TELEGRAM_CHAT_ID or not TELEGRAM_BOT_TOKEN:
        log("WARN: Telegram-auth ikke satt — pings vil feile. Sett TELEGRAM_CHAT_ID + TELEGRAM_BOT_TOKEN i PM2-env")

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

    log("approvals-runner exiting cleanly")


if __name__ == "__main__":
    try:
        mainloop()
    except Exception as e:
        log(f"fatal: {e}")
        sys.exit(1)
