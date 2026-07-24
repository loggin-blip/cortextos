#!/usr/bin/env bash
# Nattlig Drive-KB-sync wrapper — kjøres av cron kl 03:00 daglig
# Skriver sync_runs-rad (source=ml_kb_drive_nightly) + sender error-report ved feil

set -euo pipefail

# Last inn hemmeligheter fra gitignored secrets.env — hardkoding forbudt.
SECRETS_FILE="/Users/max/cortextos/orgs/massivlust/secrets.env"
if [[ ! -f "$SECRETS_FILE" ]]; then
  echo "ERROR: $SECRETS_FILE mangler" >&2
  exit 1
fi
# shellcheck disable=SC1090
set -a; source "$SECRETS_FILE"; set +a

SUPABASE_URL="https://wnnrtmtgtzcwqobnnzyo.supabase.co"
SUPABASE_KEY="${MASSIVLUST_SUPABASE_SERVICE_ROLE_KEY:?MASSIVLUST_SUPABASE_SERVICE_ROLE_KEY mangler i secrets.env}"
DASHBOARD_URL="https://ml.wdacrm.com"
CRON_SECRET="${MASSIVLUST_DASHBOARD_CRON_SECRET:?MASSIVLUST_DASHBOARD_CRON_SECRET mangler i secrets.env}"
SCRIPT="/Users/max/cortextos/scripts/massivlust/ml-kb-sync.py"
PYTHON="/opt/homebrew/bin/python3"
LOG_DIR="/Users/max/.cortextos/ml-kb-sync"

mkdir -p "$LOG_DIR"
TODAY=$(date +%Y-%m-%d)
LOG="$LOG_DIR/$TODAY.log"

supa_post() {
  curl -sS -X POST \
    -H "apikey: $SUPABASE_KEY" \
    -H "Authorization: Bearer $SUPABASE_KEY" \
    -H "Content-Type: application/json" \
    -H "Prefer: return=representation" \
    -d "$1" \
    "$SUPABASE_URL/rest/v1/massivlust_sync_runs"
}

supa_patch() {
  local id="$1"
  local body="$2"
  curl -sS -X PATCH \
    -H "apikey: $SUPABASE_KEY" \
    -H "Authorization: Bearer $SUPABASE_KEY" \
    -H "Content-Type: application/json" \
    -H "Prefer: return=representation" \
    -d "$body" \
    "$SUPABASE_URL/rest/v1/massivlust_sync_runs?id=eq.$id"
}

# --- Start sync_run ---
START_TS=$(date -u +%Y-%m-%dT%H:%M:%SZ)
RUN_PAYLOAD=$(cat <<JSON
{"source":"ml_kb_drive_nightly","status":"running","started_at":"$START_TS","org_id":"massivlust"}
JSON
)
RUN_ROW=$(supa_post "$RUN_PAYLOAD")
RUN_ID=$(echo "$RUN_ROW" | python3 -c "import sys,json; rows=json.load(sys.stdin); print(rows[0]['id'] if isinstance(rows,list) else rows['id'])" 2>/dev/null || true)
echo "[$(date -u +%H:%M:%S)] sync_run started id=$RUN_ID" >> "$LOG"

# --- Kjør script (maks 2 timer, drep stille henging) ---
EXIT_CODE=0
TEXT_ONLY=1 perl -e 'alarm(7200); exec @ARGV' -- "$PYTHON" "$SCRIPT" --skip-mail >> "$LOG" 2>&1 || EXIT_CODE=$?

END_TS=$(date -u +%Y-%m-%dT%H:%M:%SZ)

# --- Oppdater sync_run ---
if [[ "$EXIT_CODE" -eq 0 ]]; then
  STATUS="success"
  ERROR_MSG="null"
else
  STATUS="error"
  ERROR_MSG="\"ml-kb-sync.py exited with code $EXIT_CODE — sjekk $LOG\""
fi

if [[ -n "$RUN_ID" ]]; then
  supa_patch "$RUN_ID" "{\"status\":\"$STATUS\",\"ended_at\":\"$END_TS\",\"error_message\":$ERROR_MSG}" > /dev/null
fi
echo "[$(date -u +%H:%M:%S)] sync_run completed status=$STATUS exit=$EXIT_CODE" >> "$LOG"

# --- Error-report ved feil ---
if [[ "$EXIT_CODE" -ne 0 ]]; then
  curl -sS -X POST \
    -H "Authorization: Bearer $CRON_SECRET" \
    -H "Content-Type: application/json" \
    -d "{\"type\":\"data\",\"description\":\"ml-kb-nightly.sh feilet (exit $EXIT_CODE) — se $LOG\",\"severity\":\"normal\",\"context\":{\"area\":\"kb-sync\",\"exit_code\":$EXIT_CODE}}" \
    "$DASHBOARD_URL/api/cron/error-reports" > /dev/null
  echo "[$(date -u +%H:%M:%S)] error-report sendt" >> "$LOG"
fi

exit "$EXIT_CODE"
