#!/bin/bash
cd "$(dirname "$0")/.."
source .env 2>/dev/null

echo "=== Last 20 sync runs ==="
curl -s "${SUPABASE_URL}/rest/v1/massivlust_sync_runs?select=source,status,started_at,ended_at,duration_ms,rows_in,rows_upserted,rows_failed,error_message&order=started_at.desc&limit=20" \
  -H "apikey: ${SUPABASE_SERVICE_ROLE_KEY}" \
  -H "Authorization: Bearer ${SUPABASE_SERVICE_ROLE_KEY}" | \
  python3 -m json.tool 2>/dev/null || echo "(install python3 for pretty output)"
