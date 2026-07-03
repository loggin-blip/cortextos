#!/usr/bin/env bash
# E2E-test for shared-agent-pattern. Lager fake person, kjører alle 3 skills
# mot alle 3 agenter (jensen, kjoreplan, ks-avvik), sletter etter.
#
# Krever: SUPABASE_URL + MASSIVLUST_SUPABASE_SERVICE_ROLE_KEY i miljø.

set -euo pipefail

ROUTING=/Users/max/cortextos/skills/shared-agent-routing/lookup.py
PREFLIGHT=/Users/max/cortextos/skills/shared-agent-preflight/preflight.py
ONBOARD=/Users/max/cortextos/skills/shared-agent-onboarding/onboard.py

SHORT_NAME="Testbruker"
FULL_NAME="E2E Test Bruker"
EMAIL="e2e-test@massivlust.invalid"
CHAT_ID="999999001"
AGENTS=("jensen" "kjoreplan" "ks-avvik")
ROLES=("montor" "pl" "montor")
CRON_NAME="e2e-test-cron"

pass=0; fail=0
log() { printf "[%-4s] %s\n" "$1" "$2"; }
ok()   { log "PASS" "$1"; pass=$((pass+1)); }
nope() { log "FAIL" "$1"; fail=$((fail+1)); }

cleanup() {
  echo
  echo "--- Cleanup ---"
  PID=$(curl -s "$SUPABASE_URL/rest/v1/shared_persons?short_name=eq.$SHORT_NAME&select=id" \
    -H "apikey: $MASSIVLUST_SUPABASE_SERVICE_ROLE_KEY" \
    -H "Authorization: Bearer $MASSIVLUST_SUPABASE_SERVICE_ROLE_KEY" \
    | python3 -c "import json,sys; r=json.load(sys.stdin); print(r[0]['id'] if r else '')")
  if [ -n "$PID" ]; then
    curl -s -X DELETE "$SUPABASE_URL/rest/v1/shared_cron_log?person_id=eq.$PID" \
      -H "apikey: $MASSIVLUST_SUPABASE_SERVICE_ROLE_KEY" \
      -H "Authorization: Bearer $MASSIVLUST_SUPABASE_SERVICE_ROLE_KEY" >/dev/null
    curl -s -X DELETE "$SUPABASE_URL/rest/v1/shared_agent_memberships?person_id=eq.$PID" \
      -H "apikey: $MASSIVLUST_SUPABASE_SERVICE_ROLE_KEY" \
      -H "Authorization: Bearer $MASSIVLUST_SUPABASE_SERVICE_ROLE_KEY" >/dev/null
    curl -s -X DELETE "$SUPABASE_URL/rest/v1/shared_persons?id=eq.$PID" \
      -H "apikey: $MASSIVLUST_SUPABASE_SERVICE_ROLE_KEY" \
      -H "Authorization: Bearer $MASSIVLUST_SUPABASE_SERVICE_ROLE_KEY" >/dev/null
    echo "Cleaned up person_id=$PID + memberships + cron_log"
  else
    echo "Nothing to clean up (no test-person found)"
  fi
}
trap cleanup EXIT

echo "--- Setup: create test person + memberships ---"
# create_new oppretter både person + første membership
out=$(python3 "$ONBOARD" create_new \
  --agent jensen --chat-id "$CHAT_ID" \
  --short-name "$SHORT_NAME" --full-name "$FULL_NAME" \
  --email "$EMAIL" --role montor)
echo "  $out"
PID=$(echo "$out" | python3 -c "import json,sys; print(json.load(sys.stdin)['person_id'])")
echo "  test person_id=$PID"

# Bind kjoreplan:pl + ks-avvik:montor
for i in 1 2; do
  AGENT="${AGENTS[$i]}"; ROLE="${ROLES[$i]}"
  curl -s -X POST "$SUPABASE_URL/rest/v1/shared_agent_memberships" \
    -H "apikey: $MASSIVLUST_SUPABASE_SERVICE_ROLE_KEY" \
    -H "Authorization: Bearer $MASSIVLUST_SUPABASE_SERVICE_ROLE_KEY" \
    -H "Content-Type: application/json" \
    -H "Prefer: return=minimal" \
    -d "{\"person_id\":\"$PID\",\"agent_name\":\"$AGENT\",\"role\":\"$ROLE\",\"telegram_chat_id\":\"$CHAT_ID\",\"active\":true,\"onboarded_at\":\"now()\",\"last_seen_at\":\"now()\"}"
done

echo
echo "--- Test 1: routing.list_active picks up test-person on all 3 agents ---"
for i in 0 1 2; do
  AGENT="${AGENTS[$i]}"; ROLE="${ROLES[$i]}"
  found=$(python3 "$ROUTING" list_active --agent "$AGENT" --role "$ROLE" \
    | python3 -c "import json,sys; d=json.load(sys.stdin); print(any(x['short_name']=='$SHORT_NAME' for x in d['data']))")
  if [ "$found" = "True" ]; then ok "list_active $AGENT:$ROLE finner Testbruker"
  else nope "list_active $AGENT:$ROLE finner IKKE Testbruker"; fi
done

echo
echo "--- Test 2: routing.get_chat_id returns CHAT_ID ---"
for AGENT in "${AGENTS[@]}"; do
  cid=$(python3 "$ROUTING" get_chat_id --agent "$AGENT" --short-name "$SHORT_NAME" \
    | python3 -c "import json,sys; d=json.load(sys.stdin); rows=d.get('data') or []; print(rows[0]['telegram_chat_id'] if rows else '')")
  if [ "$cid" = "$CHAT_ID" ]; then ok "get_chat_id $AGENT → $CHAT_ID"
  else nope "get_chat_id $AGENT returnerte '$cid' (forventet $CHAT_ID)"; fi
done

echo
echo "--- Test 3: onboarding.check_chat with bound CHAT_ID returns found=true ---"
for AGENT in "${AGENTS[@]}"; do
  found=$(python3 "$ONBOARD" check_chat --agent "$AGENT" --chat-id "$CHAT_ID" \
    | python3 -c "import json,sys; print(json.load(sys.stdin).get('found'))")
  if [ "$found" = "True" ]; then ok "check_chat $AGENT → found=true"
  else nope "check_chat $AGENT returnerte found=$found"; fi
done

echo
echo "--- Test 4: onboarding.check_chat with unknown chat_id returns found=false ---"
unknown_cid="888888888"
for AGENT in "${AGENTS[@]}"; do
  found=$(python3 "$ONBOARD" check_chat --agent "$AGENT" --chat-id "$unknown_cid" \
    | python3 -c "import json,sys; print(json.load(sys.stdin).get('found'))")
  if [ "$found" = "False" ]; then ok "check_chat $AGENT unknown → found=false"
  else nope "check_chat $AGENT unknown returnerte found=$found"; fi
done

echo
echo "--- Test 5: preflight.check med has_items=true gir go=true (utenfor quiet hours) ---"
# Note: quiet_hours default 17-07. Hvis vi kjører innen quiet hours, forvent go=false m/reason=quiet_hours
hour=$(date +%H)
expected_go="True"
expected_reason="ok"
if [ "$hour" -ge 17 ] || [ "$hour" -lt 7 ]; then
  expected_go="False"
  expected_reason="quiet_hours"
fi
for AGENT in "${AGENTS[@]}"; do
  res=$(python3 "$PREFLIGHT" check \
    --person-id "$PID" --agent "$AGENT" --cron-name "$CRON_NAME" \
    --cooldown-hours 24 --has-items true)
  go=$(echo "$res" | python3 -c "import json,sys; print(json.load(sys.stdin).get('go'))")
  reason=$(echo "$res" | python3 -c "import json,sys; print(json.load(sys.stdin).get('reason'))")
  if [ "$go" = "$expected_go" ]; then ok "preflight $AGENT → go=$go reason=$reason"
  else nope "preflight $AGENT → go=$go reason=$reason (forventet go=$expected_go)"; fi
done

echo
echo "--- Test 6: preflight.log + cooldown håndhevelse ---"
# Logg en sent for jensen, deretter sjekk at cooldown=24h kicker
python3 "$PREFLIGHT" log --person-id "$PID" --agent jensen --cron-name "$CRON_NAME" --outcome sent > /dev/null
res=$(python3 "$PREFLIGHT" check --person-id "$PID" --agent jensen --cron-name "$CRON_NAME" \
  --cooldown-hours 24 --has-items true)
go=$(echo "$res" | python3 -c "import json,sys; print(json.load(sys.stdin).get('go'))")
reason=$(echo "$res" | python3 -c "import json,sys; print(json.load(sys.stdin).get('reason'))")
if [ "$go" = "False" ] && [ "$reason" = "cooldown" ]; then
  ok "preflight cooldown håndheves etter 'sent'-log (go=false reason=cooldown)"
else
  nope "preflight cooldown ikke håndhevet: go=$go reason=$reason"
fi

echo
echo "--- Test 7: preflight.check med has_items=false gir go=false reason=no_items ---"
res=$(python3 "$PREFLIGHT" check --person-id "$PID" --agent kjoreplan --cron-name "${CRON_NAME}-noitems" \
  --cooldown-hours 0 --has-items false)
go=$(echo "$res" | python3 -c "import json,sys; print(json.load(sys.stdin).get('go'))")
reason=$(echo "$res" | python3 -c "import json,sys; print(json.load(sys.stdin).get('reason'))")
# Hvis vi er innen quiet hours, vil reason=quiet_hours komme først (preflight har den sjekken før no_items)
if [ "$expected_reason" = "quiet_hours" ]; then
  if [ "$go" = "False" ] && [ "$reason" = "quiet_hours" ]; then
    ok "preflight no_items innen quiet hours → quiet_hours dekker (go=false)"
  else
    nope "preflight no_items innen quiet hours feilet: go=$go reason=$reason"
  fi
else
  if [ "$go" = "False" ] && [ "$reason" = "no_items" ]; then
    ok "preflight no_items → go=false reason=no_items"
  else
    nope "preflight no_items feilet: go=$go reason=$reason"
  fi
fi

echo
echo "================================"
echo "PASS: $pass  FAIL: $fail"
echo "================================"
[ "$fail" -eq 0 ] || exit 1
