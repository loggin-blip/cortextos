#!/usr/bin/env bash
# auto-feeder.sh — If qwen-worker queue is empty, dispatch a "fill"-task so
# Mac Studio utilization stays high. Called by hourly cron or manually.
#
# Pattern: lightweight cron-script, NOT a daemon. Keeps infra simple.
#
# Backlog-rotation: cycles through a fixed list of "nice-to-have" bulk-jobs
# that are useful to refresh daily/hourly:
#   - fleet-memory-consolidation (refresh historical context-map)
#   - daily-digest-sample (preview for morning-brief prep)
#   - kb-health-check (count KB entries, flag duplicates)
#   - vault-freshness-snapshot (quick obsidian-vault stats)
#   - dropzone-scan (check for new iCloud-dropzone files awaiting processing)
#
# Only dispatches if queue is COMPLETELY empty (0 pending + 0 in-progress)
# so we don't flood worker.

set -euo pipefail

LOG_DIR="$HOME/.cortextos/default/logs/auto-feeder"
mkdir -p "$LOG_DIR"
LOG="$LOG_DIR/stdout.log"
STATE="$LOG_DIR/rotation.state"

log() {
  echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] $*" | tee -a "$LOG" >&2
}

# Check queue — if anything pending OR in-progress, skip
PENDING=$(cortextos bus list-tasks --agent qwen-worker --status pending --format json 2>/dev/null | python3 -c "import json,sys;print(len(json.load(sys.stdin)) if sys.stdin.readable() else 0)" 2>/dev/null || echo 0)
INPROG=$(cortextos bus list-tasks --agent qwen-worker --status in_progress --format json 2>/dev/null | python3 -c "import json,sys;print(len(json.load(sys.stdin)) if sys.stdin.readable() else 0)" 2>/dev/null || echo 0)
TOTAL=$((PENDING + INPROG))

if [[ "$TOTAL" -gt 0 ]]; then
  log "SKIP — queue has $PENDING pending + $INPROG in-progress"
  exit 0
fi

# Queue is empty — pick next backlog-item via rotation-counter
if [[ -f "$STATE" ]]; then
  IDX=$(cat "$STATE")
else
  IDX=0
fi

# Backlog rotation — 5 items, cycle through
case "$IDX" in
  0)
    TITLE="Auto-feeder: fleet-memory-consolidation"
    DESC="Konsolider alle memory/YYYY-MM-DD.md filer i alle agent-memory-mapper. Produser timeline-view: per dato, 3-5 nøkkelhendelser på tvers av hele fleet. Output: deliverables/auto-feeder-memory-timeline-$(date +%Y-%m-%d).md. Norsk. Kort format."
    ;;
  1)
    TITLE="Auto-feeder: daily-digest sample"
    DESC="Generer sample daily-digest: hva fleet oppnådde i dag (top 5 tasks), health-line, risks-framover. Output: deliverables/auto-feeder-digest-$(date +%Y-%m-%d).md. Norsk, kort."
    ;;
  2)
    TITLE="Auto-feeder: KB health-check"
    DESC="Sjekk cortextos bus kb-collections for status på alle KB-samlinger. Lag rapport: collection-navn, chunk-count, siste oppdatering. Flag evt duplikat-risiko. Output: deliverables/auto-feeder-kb-health-$(date +%Y-%m-%d).md."
    ;;
  3)
    TITLE="Auto-feeder: vault-freshness snapshot"
    DESC="For hver iCloud-vault (life-os, nordflo, westside-hq, max-brain): tell antall .md-filer, siste modifisert dato, estimer vault-størrelse. Output: deliverables/auto-feeder-vault-snapshot-$(date +%Y-%m-%d).md."
    ;;
  4)
    TITLE="Auto-feeder: dropzone-scan"
    DESC="Sjekk ~/Library/Mobile Documents/com~apple~CloudDocs/wda-dropzone/ for nye filer. List filnavn, størrelse, modifisert. Flag hvilke som trenger prosessering. Output: deliverables/auto-feeder-dropzone-$(date +%Y-%m-%d).md."
    ;;
esac

# Dispatch
RESULT=$(cortextos bus create-task "$TITLE" --desc "$DESC" --assignee qwen-worker --priority low 2>&1 | tail -1)
log "DISPATCHED idx=$IDX task=$RESULT title='$TITLE'"

# Advance rotation-index
NEW_IDX=$(( (IDX + 1) % 5 ))
echo "$NEW_IDX" > "$STATE"

# Log completion
cortextos bus log-event action cron_completed info --meta "{\"cron\":\"auto-feeder\",\"dispatched\":true,\"idx\":$IDX,\"task_id\":\"$RESULT\"}" 2>&1 | head -1 >&2 || true
