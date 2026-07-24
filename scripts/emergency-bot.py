#!/usr/bin/env python3
"""
sistefailsafe_bot — emergency remote hand for Max.
Completely independent of cortextos daemon and pm2.
Runs as its own launchd job. Survives daemon/pm2 crashes.

Commands (only from ALLOWED_CHAT_ID):
  /ping              — confirm bot is alive
  /status            — pm2 list + top processes
  /restart           — pm2 restart cortextos-daemon (or full resurrect)
  /start <agent>     — cortextos start <agent>
  /logs [agent]      — last 30 lines of agent stdout (default: kaptein)
  /kill              — kill all runaway claude --print processes
"""

import os
import subprocess
import time
import json
import logging
import signal
import sys
from datetime import datetime, timezone
from urllib.parse import urlencode
from urllib.request import urlopen, Request
from urllib.error import URLError

# ── Config ──────────────────────────────────────────────────────────────
BOT_TOKEN       = "8955806843:AAFNGzjlP57hWpJeu1ZsZ9cL3PheTo0H7vI"
ALLOWED_CHAT_ID = 6447044389
POLL_TIMEOUT    = 30          # long-poll seconds
LOG_FILE        = "/Users/max/.cortextos/emergency-bot.log"
CTX_ROOT        = "/Users/max/.cortextos/default"
CORTEXTOS_BIN   = "/opt/homebrew/bin/cortextos"
PM2_BIN         = "/opt/homebrew/bin/pm2"
PYTHON_BIN      = "/opt/homebrew/bin/python3"
PATH_ENV        = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

API = f"https://api.telegram.org/bot{BOT_TOKEN}"

# ── Logging ──────────────────────────────────────────────────────────────
os.makedirs(os.path.dirname(LOG_FILE), exist_ok=True)
logging.basicConfig(
    filename=LOG_FILE,
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(message)s",
    datefmt="%Y-%m-%dT%H:%M:%SZ",
)
log = logging.getLogger("emergency-bot")


def tg_get(method: str, params: dict | None = None) -> dict:
    url = f"{API}/{method}"
    if params:
        url += "?" + urlencode(params)
    req = Request(url, headers={"User-Agent": "emergency-bot/1.0"})
    with urlopen(req, timeout=POLL_TIMEOUT + 5) as r:
        return json.load(r)


def tg_post(method: str, data: dict) -> dict:
    body = json.dumps(data).encode()
    req = Request(
        f"{API}/{method}",
        data=body,
        headers={"Content-Type": "application/json", "User-Agent": "emergency-bot/1.0"},
    )
    with urlopen(req, timeout=15) as r:
        return json.load(r)


def send(chat_id: int, text: str) -> None:
    try:
        tg_post("sendMessage", {"chat_id": chat_id, "text": text})
    except Exception as e:
        log.error("send failed: %s", e)


def run(cmd: list[str], timeout: int = 20) -> str:
    env = {**os.environ, "PATH": PATH_ENV, "HOME": "/Users/max"}
    try:
        r = subprocess.run(
            cmd, capture_output=True, text=True, timeout=timeout, env=env
        )
        return (r.stdout + r.stderr).strip()
    except subprocess.TimeoutExpired:
        return f"(timeout after {timeout}s)"
    except Exception as e:
        return f"(error: {e})"


# ── Command handlers ──────────────────────────────────────────────────────

def cmd_ping(args: str) -> str:
    now = datetime.now(timezone.utc).strftime("%H:%M:%S UTC")
    return f"Alive — {now}"


def cmd_status(args: str) -> str:
    pm2_out = run([PM2_BIN, "list", "--no-color"], timeout=10)
    # Summarise: just count online vs stopped
    lines = [l for l in pm2_out.splitlines() if "│" in l and "name" not in l.lower()]
    online = sum(1 for l in lines if "online" in l)
    stopped = sum(1 for l in lines if "stopped" in l or "errored" in l)
    # Check cortextos-daemon specifically
    daemon_line = next((l for l in pm2_out.splitlines() if "cortextos" in l.lower()), "")
    daemon_status = "ok" if "online" in daemon_line else "DOWN"
    return (
        f"pm2: {online} online, {stopped} stopped\n"
        f"cortextos-daemon: {daemon_status}\n"
        f"Mac time: {datetime.now().strftime('%H:%M:%S')}"
    )


def cmd_restart(args: str) -> str:
    # Try pm2 restart first, fall back to resurrect
    out = run([PM2_BIN, "restart", "cortextos-daemon"], timeout=20)
    if "error" in out.lower() or "not found" in out.lower():
        out2 = run([PM2_BIN, "resurrect"], timeout=20)
        return f"restart failed, tried resurrect:\n{out2[:300]}"
    return f"Restartet cortextos-daemon.\n{out[:200]}"


def cmd_start(args: str) -> str:
    agent = args.strip()
    if not agent:
        return "Bruk: /start <agent-navn>"
    if not agent.replace("-", "").replace("_", "").isalnum():
        return "Ugyldig agent-navn."
    out = run([CORTEXTOS_BIN, "start", agent], timeout=20)
    return out[:400] or "Ferdig."


def cmd_logs(args: str) -> str:
    agent = args.strip() or "kaptein"
    if not agent.replace("-", "").replace("_", "").isalnum():
        return "Ugyldig agent-navn."
    log_path = f"{CTX_ROOT}/logs/{agent}/stdout.log"
    if not os.path.exists(log_path):
        return f"Ingen logg funnet: {log_path}"
    try:
        with open(log_path, "rb") as f:
            f.seek(0, 2)
            size = f.tell()
            f.seek(max(0, size - 4096))
            tail = f.read().decode("utf-8", errors="replace")
        lines = tail.splitlines()[-30:]
        return f"[{agent} siste 30 linjer]\n" + "\n".join(lines)[-1000:]
    except Exception as e:
        return f"Feil: {e}"


def cmd_kill(args: str) -> str:
    out = run(["pkill", "-f", "claude --print"], timeout=10)
    count = run(["pgrep", "-c", "-f", "claude --print"], timeout=5)
    return f"kill sendt. claude --print igjen: {count}\n{out[:200]}"


COMMANDS = {
    "/ping":    cmd_ping,
    "/status":  cmd_status,
    "/restart": cmd_restart,
    "/start":   cmd_start,
    "/logs":    cmd_logs,
    "/kill":    cmd_kill,
}

HELP_TEXT = (
    "sistefailsafe — nødkommandoer:\n"
    "/ping — er boten i live?\n"
    "/status — pm2 + cortextos status\n"
    "/restart — restart cortextos-daemon\n"
    "/start <agent> — start en agent\n"
    "/logs [agent] — siste linjer (default: kaptein)\n"
    "/kill — drep alle claude --print prosesser"
)


def handle(update: dict) -> None:
    msg = update.get("message") or update.get("edited_message")
    if not msg:
        return
    chat_id = msg.get("chat", {}).get("id")
    text = (msg.get("text") or "").strip()
    if chat_id != ALLOWED_CHAT_ID:
        log.warning("Ignored message from unauthorized chat_id=%s", chat_id)
        return
    if not text:
        return

    log.info("Command from %s: %s", chat_id, text[:100])

    # Parse command and args
    parts = text.split(None, 1)
    cmd = parts[0].lower().split("@")[0]  # strip @botname suffix
    args = parts[1] if len(parts) > 1 else ""

    handler = COMMANDS.get(cmd)
    if handler:
        try:
            reply = handler(args)
        except Exception as e:
            reply = f"Feil: {e}"
    elif cmd in ("/help", "/start"):
        reply = HELP_TEXT
    else:
        reply = f"Ukjent kommando. {HELP_TEXT}"

    send(chat_id, reply)


def main() -> None:
    log.info("emergency-bot starting — @sistefailsafe_bot")
    offset = 0
    consecutive_errors = 0

    def _shutdown(sig, frame):
        log.info("Shutting down (signal %s)", sig)
        sys.exit(0)

    signal.signal(signal.SIGTERM, _shutdown)
    signal.signal(signal.SIGINT, _shutdown)

    while True:
        try:
            data = tg_get("getUpdates", {"offset": offset, "timeout": POLL_TIMEOUT})
            consecutive_errors = 0
            for update in data.get("result", []):
                offset = update["update_id"] + 1
                try:
                    handle(update)
                except Exception as e:
                    log.error("handle error: %s", e)
        except URLError as e:
            consecutive_errors += 1
            log.warning("Network error (%d): %s", consecutive_errors, e)
            time.sleep(min(30, 5 * consecutive_errors))
        except Exception as e:
            consecutive_errors += 1
            log.error("Poll error (%d): %s", consecutive_errors, e)
            time.sleep(min(60, 10 * consecutive_errors))


if __name__ == "__main__":
    main()
