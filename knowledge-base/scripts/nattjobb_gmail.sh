#!/bin/bash
# Autonom nattjobb: skalerer gmail-indeksering til KB.
# Hard stopp: 04:00 UTC (kl 06:00 Oslo-tid).
# Kjører batcher av 200 tråder med offset, rapporterer til bridge etter hver batch.

set -e
cd "$(dirname "$0")/.."

# Supabase-creds leses fra env-fila (ikke hardkodet):
set -a; . /Users/max/cortextos/agent-engine/.env.local; set +a
SA_KEY="$(pwd)/google-sa-key.json"
OLLAMA="http://localhost:11434"
CHAT_ID="6447044389"

export SUPABASE_URL SUPABASE_SERVICE_ROLE_KEY SA_KEY OLLAMA

BATCH_SIZE=200
OFFSET=400   # batch 0 (0-200 test) + batch 1 (200-400) allerede kjørt

# Hard stopp: 04:00 UTC 2026-07-02
STOP_EPOCH=$(date -u -j -f "%Y-%m-%d %H:%M:%S" "2026-07-02 04:00:00" "+%s" 2>/dev/null \
  || date -u -d "2026-07-02 04:00:00" "+%s" 2>/dev/null \
  || echo "1782964800")  # fallback: 2026-07-02T04:00:00Z

stop_after_utc() {
  current_epoch=$(date -u +%s)
  if [ "$current_epoch" -ge "$STOP_EPOCH" ]; then
    return 0
  fi
  return 1
}

send_tg() {
  curl -s -X POST "https://api.telegram.org/bot$1/sendMessage" \
    -d "chat_id=$CHAT_ID" \
    --data-urlencode "text=$2" > /dev/null 2>&1 || true
}

# Hent bot token fra env
BOT_TOKEN="${TELEGRAM_BOT_TOKEN:-}"
if [ -z "$BOT_TOKEN" ]; then
  # Prøv å lese fra .env filen til massivlust-dev agent
  BOT_TOKEN=$(grep "^BOT_TOKEN=" /Users/max/cortextos/orgs/westside-hq/agents/massivlust-dev/.env 2>/dev/null | cut -d= -f2 | tr -d '"' | tr -d "'")
fi

echo "=== NATTJOBB START: $(date -u) ==="
echo "Batch-størrelse: $BATCH_SIZE, Start-offset: $OFFSET"
echo "Hard stopp: 04:00 UTC"

batch_num=0
total_indexed=0
total_noise=0
total_privat=0

while true; do
  # Hard stopp: 04:00 UTC
  if stop_after_utc; then
    echo ""
    echo "=== STOPP: 04:00 UTC nådd ==="
    echo "Totalt indeksert: $total_indexed | Støy: $total_noise | Privat: $total_privat"
    echo "Gjenstående: Offset $OFFSET+"

    msg="Nattjobb STOPP kl 04:00 UTC.
Totalt indeksert: $total_indexed nye tråder
Støy filtrert: $total_noise
Privat hoppet: $total_privat
Neste offset: $OFFSET
Kl 06 Oslo: se KB-dashboard."

    [ -n "$BOT_TOKEN" ] && send_tg "$BOT_TOKEN" "$msg"
    break
  fi

  batch_num=$((batch_num + 1))
  echo ""
  echo "--- Batch $batch_num | Offset $OFFSET | $(date -u +%H:%M) UTC ---"

  result=$(venv/bin/python3 scripts/studio_mail_ingest.py \
    "alex@massivlust.no" "" "$BATCH_SIZE" "$OFFSET" 2>&1)

  echo "$result"

  # Parse resultat — bruk sed (macOS-kompatibelt, ingen -P flag)
  ferdig_line=$(echo "$result" | grep "MAIL FERDIG" || true)
  indexed=$(echo "$ferdig_line" | sed 's/.*FERDIG: \([0-9]*\) indeksert.*/\1/' | grep -E '^[0-9]+$' || echo "0")
  noise=$(echo "$ferdig_line" | sed 's/.*, \([0-9]*\) støy.*/\1/' | grep -E '^[0-9]+$' || echo "0")
  privat=$(echo "$ferdig_line" | sed 's/.*, \([0-9]*\) privat.*/\1/' | grep -E '^[0-9]+$' || echo "0")
  chroma=$(echo "$ferdig_line" | sed 's/.*Collection: \([0-9]*\).*/\1/' | grep -E '^[0-9]+$' || echo "?")

  # Sett 0 som default om parse feiler
  indexed=${indexed:-0}; noise=${noise:-0}; privat=${privat:-0}

  total_indexed=$((total_indexed + indexed))
  total_noise=$((total_noise + noise))
  total_privat=$((total_privat + privat))
  OFFSET=$((OFFSET + BATCH_SIZE))

  echo "Batch $batch_num: +$indexed indeksert, $noise støy, $privat privat. ChromaDB: $chroma"

  # Tom batch betyr at det faktisk er 0 tråder hentet (ikke parse-feil)
  # Sjekk om python-skriptet rapporterte "0 tråder" — da er vi ferdig
  if echo "$result" | grep -qE ": 0 tråder"; then
    echo "Tom batch (0 tråder returnert fra Gmail) — ferdig."
    msg="Nattjobb FERDIG (tom Gmail-respons ved offset $OFFSET).
Totalt: $total_indexed indeksert, $total_noise støy, $total_privat privat.
ChromaDB: $chroma docs."
    [ -n "$BOT_TOKEN" ] && send_tg "$BOT_TOKEN" "$msg"
    break
  fi

  # Throttle: 30 sek mellom batches
  echo "Throttle 30s…"
  sleep 30
done

echo "=== NATTJOBB FERDIG: $(date -u) ==="
