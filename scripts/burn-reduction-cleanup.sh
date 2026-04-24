#!/usr/bin/env bash
# burn-reduction-cleanup.sh — apply config-level QW changes to reduce overhead.
# Run after merging perf/burn-reduction-2026-04-24 branch.
#
# Actions:
#   1. Remove interval-based heartbeat crons from agents that migrated to heartbeat-runner
#   2. Set runner_managed=true on any remaining heartbeat/check-approvals crons (documentation)
#   3. Add nightly-compact cron to orchestrator agents
#
# Idempotent — safe to re-run.

set -euo pipefail

AGENTS_DIR="/Users/max/cortextos/orgs/westside-hq/agents"
CHANGED=0

# Agents that use heartbeat-runner (all of them in current setup)
ALL_AGENTS="kaptein max-personal nordflo-dev massivlust-dev leon-kaptein leon-personal"

# 1. Remove heartbeat cron (migrated to runner)
for AGENT in $ALL_AGENTS; do
  FILE="$AGENTS_DIR/$AGENT/config.json"
  [[ ! -f "$FILE" ]] && continue
  BEFORE=$(jq '.crons | length' "$FILE")
  jq '.crons = (.crons | map(select(.name != "heartbeat" and .name != "check-approvals")))' "$FILE" > /tmp/c.json && mv /tmp/c.json "$FILE"
  AFTER=$(jq '.crons | length' "$FILE")
  if [[ "$BEFORE" != "$AFTER" ]]; then
    echo "  $AGENT: removed heartbeat/check-approvals crons ($BEFORE → $AFTER)"
    CHANGED=1
  fi
done

# 2. Add nightly-compact to orchestrators if not already present
for AGENT in kaptein leon-kaptein; do
  FILE="$AGENTS_DIR/$AGENT/config.json"
  [[ ! -f "$FILE" ]] && continue
  HAS=$(jq '[.crons[]?.name] | any(. == "nightly-compact")' "$FILE")
  if [[ "$HAS" == "false" ]]; then
    # Stagger times: kaptein 03:13, leon-kaptein 03:47
    if [[ "$AGENT" == "kaptein" ]]; then
      CRON="13 3 * * *"
    else
      CRON="47 3 * * *"
    fi
    jq --arg cron "$CRON" '.crons += [{
      "name":"nightly-compact",
      "type":"recurring",
      "cron": $cron,
      "prompt":"Run /compact to shed accumulated conversation context. Do not do any other work in this invocation — just compact and return to idle."
    }]' "$FILE" > /tmp/c.json && mv /tmp/c.json "$FILE"
    echo "  $AGENT: added nightly-compact cron at $CRON"
    CHANGED=1
  fi
done

echo ""
if [[ $CHANGED -eq 1 ]]; then
  echo "Config changes applied. Restart fleet to pick up:"
  echo "  pm2 kill && cortextos start"
else
  echo "No changes needed — all agents already clean."
fi
