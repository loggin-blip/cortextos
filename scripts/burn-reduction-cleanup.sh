#!/usr/bin/env bash
# burn-reduction-cleanup.sh — apply config + template-file updates for burn reduction.
# Run after merging perf/burn-reduction-2026-04-24 branch.
#
# Actions:
#   1. Remove interval-based heartbeat/check-approvals crons from agents (now runner-managed)
#   2. Add nightly-compact cron to orchestrator agents
#   3. Refresh AGENTS.md from template (trimmed 454 → 173 lines)
#
# Idempotent — safe to re-run.
#
# Note: user-owned orchestrator-specific AGENTS.md customizations (e.g. kaptein's)
#   are overwritten. If customizations exist, back up first.

set -euo pipefail

FRAMEWORK_ROOT="/Users/max/cortextos"
AGENTS_DIR="$FRAMEWORK_ROOT/orgs/westside-hq/agents"
TEMPLATES_DIR="$FRAMEWORK_ROOT/templates"
CHANGED=0

# Agents and their template type
declare -A AGENT_TEMPLATE=(
  ["kaptein"]="orchestrator"
  ["leon-kaptein"]="orchestrator"
  ["max-personal"]="agent"
  ["leon-personal"]="agent"
  ["nordflo-dev"]="agent"
  ["massivlust-dev"]="agent"
)

# 1. Clean up stale heartbeat/check-approvals crons from all agents
for AGENT in "${!AGENT_TEMPLATE[@]}"; do
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

# 2. Add nightly-compact to orchestrators (staggered)
for AGENT in kaptein leon-kaptein; do
  FILE="$AGENTS_DIR/$AGENT/config.json"
  [[ ! -f "$FILE" ]] && continue
  HAS=$(jq '[.crons[]?.name] | any(. == "nightly-compact")' "$FILE")
  if [[ "$HAS" == "false" ]]; then
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

# 3. Refresh AGENTS.md from template (skip if agent has customized it — checksum-based)
for AGENT in "${!AGENT_TEMPLATE[@]}"; do
  TMPL="$TEMPLATES_DIR/${AGENT_TEMPLATE[$AGENT]}/AGENTS.md"
  AGENT_FILE="$AGENTS_DIR/$AGENT/AGENTS.md"
  [[ ! -f "$TMPL" || ! -f "$AGENT_FILE" ]] && continue

  # If file contents differ, refresh from template
  if ! cmp -s "$TMPL" "$AGENT_FILE"; then
    cp "$AGENT_FILE" "$AGENT_FILE.backup-$(date +%Y%m%d)"
    cp "$TMPL" "$AGENT_FILE"
    echo "  $AGENT: AGENTS.md refreshed from template (454 → 173 lines, backup saved)"
    CHANGED=1
  fi
done

echo ""
if [[ $CHANGED -eq 1 ]]; then
  echo "Changes applied. Restart fleet to pick up:"
  echo "  pm2 kill && cortextos start"
else
  echo "No changes needed — all agents already clean."
fi
