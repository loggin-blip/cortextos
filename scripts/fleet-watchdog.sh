#!/usr/bin/env bash
# fleet-watchdog.sh — fleet health monitor
# Runs via launchd every 15 min. Only restarts agents whose PROCESS is dead.
# Never restarts based on heartbeat staleness alone — idle agents are fine.
#
# What it catches:
#   1. pm2 daemon dead → pm2 resurrect
#   2. cortextos daemon stopped/errored → restart
#   3. Agent process not running → cortextos start <name>
#
# What it does NOT do:
#   - Restart agents just because heartbeat is stale (idle ≠ dead)
#   - Spam Telegram with routine status updates

export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"
export HOME="/Users/max"

CORTEXTOS_ROOT="/Users/max/cortextos"
LOG_FILE="/Users/max/.cortextos/watchdog.log"
BOT_TOKEN="8536486806:AAGTlnxPhKiTxEsdYrjLlbXczGB8Wfz4qMc"
CHAT_ID="6447044389"

mkdir -p "$(dirname "$LOG_FILE")"

log() {
  echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] $*" >> "$LOG_FILE"
}

send_telegram() {
  local msg="$1"
  curl -s -m 10 -X POST \
    "https://api.telegram.org/bot${BOT_TOKEN}/sendMessage" \
    -d chat_id="$CHAT_ID" \
    -d text="$msg" > /dev/null 2>&1 || log "WARN: Telegram send failed (network?)"
}

# Rotate log if > 1MB
if [[ -f "$LOG_FILE" ]] && [[ $(stat -f%z "$LOG_FILE" 2>/dev/null || echo 0) -gt 1048576 ]]; then
  mv "$LOG_FILE" "${LOG_FILE}.old"
fi

log "--- Watchdog cycle start ---"

# ============================================================
# CHECK 1: Is pm2 daemon alive?
# ============================================================
if ! pm2 jlist > /dev/null 2>&1; then
  log "CRITICAL: pm2 daemon is dead. Attempting resurrect..."
  pm2 resurrect 2>> "$LOG_FILE" || true
  sleep 3
  if ! pm2 jlist > /dev/null 2>&1; then
    log "CRITICAL: pm2 resurrect failed. Starting cortextos from scratch..."
    cd "$CORTEXTOS_ROOT"
    cortextos start 2>> "$LOG_FILE" || true
    sleep 10
  fi
  if pm2 jlist > /dev/null 2>&1; then
    log "RECOVERED: pm2 daemon is back"
    send_telegram "Watchdog: pm2 daemon var nede — gjenopprettet."
  else
    log "FAILED: Could not recover pm2 daemon"
    send_telegram "KRITISK: Watchdog klarte ikke starte pm2. Sjekk maskinen."
  fi
  log "--- Watchdog cycle end (pm2 recovery) ---"
  exit 0
fi

# ============================================================
# CHECK 2: Is cortextos daemon process running in pm2?
# ============================================================
DAEMON_STATUS=$(pm2 jlist 2>/dev/null | python3 -c "
import json, sys
try:
    procs = json.load(sys.stdin)
    for p in procs:
        if 'cortextos' in p.get('name', '').lower():
            print(p.get('pm2_env', {}).get('status', 'unknown'))
            sys.exit(0)
    print('not_found')
except:
    print('error')
" 2>/dev/null || echo "error")

if [[ "$DAEMON_STATUS" == "not_found" || "$DAEMON_STATUS" == "error" ]]; then
  log "CRITICAL: cortextos daemon not found in pm2. Starting..."
  cd "$CORTEXTOS_ROOT"
  cortextos start 2>> "$LOG_FILE" || true
  sleep 15
  send_telegram "Watchdog: cortextos daemon var borte — startet på nytt."
  log "--- Watchdog cycle end (daemon recovery) ---"
  exit 0
elif [[ "$DAEMON_STATUS" == "stopped" || "$DAEMON_STATUS" == "errored" ]]; then
  log "CRITICAL: cortextos daemon is $DAEMON_STATUS. Restarting..."
  pm2 restart cortextos-daemon 2>> "$LOG_FILE" || cortextos start 2>> "$LOG_FILE" || true
  sleep 15
  send_telegram "Watchdog: cortextos daemon var $DAEMON_STATUS — restartet."
  log "--- Watchdog cycle end (daemon restart) ---"
  exit 0
fi

# ============================================================
# CHECK 3: Node process leak (Next.js Turbopack spawns thousands)
# ============================================================
NODE_COUNT=$(pgrep -c node 2>/dev/null || echo 0)
NODE_THRESHOLD=100

if [[ "$NODE_COUNT" -gt "$NODE_THRESHOLD" ]]; then
  log "CRITICAL: $NODE_COUNT node processes (threshold: $NODE_THRESHOLD). Killing next-server..."
  # Find and kill next-server parent processes (the leak source)
  NEXT_PIDS=$(pgrep -f "next-server" 2>/dev/null || true)
  if [[ -n "$NEXT_PIDS" ]]; then
    for pid in $NEXT_PIDS; do
      kill -9 "$pid" 2>/dev/null || true
      log "Killed next-server PID $pid"
    done
    sleep 2
    # Kill any orphaned children
    REMAINING=$(pgrep -c node 2>/dev/null || echo 0)
    if [[ "$REMAINING" -gt "$NODE_THRESHOLD" ]]; then
      pkill -9 -f "next-server" 2>/dev/null || true
      sleep 1
    fi
    AFTER=$(pgrep -c node 2>/dev/null || echo 0)
    log "Node processes after cleanup: $AFTER (was $NODE_COUNT)"
    send_telegram "Watchdog: Next.js leak — $NODE_COUNT node-prosesser drept (terskel: $NODE_THRESHOLD). Dashboard er nede, start manuelt ved behov."
  else
    log "WARN: $NODE_COUNT node processes but no next-server found — skipping auto-kill"
  fi
fi

# ============================================================
# CHECK 4: Per-agent process health
# Only restart agents whose process is actually dead/stopped.
# ============================================================
ACTIONS_TAKEN=0
AGENTS_CHECKED=0
PROBLEMS=""

# Get expected agents from cortextos status
AGENT_STATUSES=$(cortextos status 2>/dev/null || echo "")

if [[ -z "$AGENT_STATUSES" ]]; then
  log "WARN: cortextos status returned empty — daemon may be starting up"
  log "--- Watchdog cycle end ---"
  exit 0
fi

# Parse agent statuses: find agents that are stopped/errored
while IFS= read -r line; do
  # Skip header lines
  [[ "$line" == *"Name"* ]] && continue
  [[ "$line" == *"---"* ]] && continue
  [[ -z "$line" ]] && continue

  agent_name=$(echo "$line" | awk '{print $1}')
  [[ -z "$agent_name" ]] && continue

  AGENTS_CHECKED=$((AGENTS_CHECKED + 1))

  if echo "$line" | grep -qi "stopped\|errored\|crashed"; then
    log "ACTION: $agent_name is dead (stopped/errored). Restarting..."
    cortextos start "$agent_name" 2>> "$LOG_FILE" || true
    ACTIONS_TAKEN=$((ACTIONS_TAKEN + 1))
    PROBLEMS="${PROBLEMS}
- ${agent_name}: process dead, restarted"
  elif echo "$line" | grep -qi "running"; then
    log "OK: $agent_name running"
  else
    log "UNKNOWN: $agent_name status unclear: $line"
  fi
done <<< "$AGENT_STATUSES"

# ============================================================
# REPORT — only Telegram on actual restarts
# ============================================================
if [[ $ACTIONS_TAKEN -gt 0 ]]; then
  send_telegram "Watchdog: ${ACTIONS_TAKEN} døde agent(er) restartet.${PROBLEMS}"
  log "REPORT: $ACTIONS_TAKEN restarts across $AGENTS_CHECKED agents"
else
  log "OK: All $AGENTS_CHECKED agents running"
fi

log "--- Watchdog cycle end ---"
