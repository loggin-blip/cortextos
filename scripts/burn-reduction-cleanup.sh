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
# Note: bash 3.2 compatible (no associative arrays — macOS default).

set -eo pipefail

FRAMEWORK_ROOT="/Users/max/cortextos"
AGENTS_DIR="$FRAMEWORK_ROOT/orgs/westside-hq/agents"
TEMPLATES_DIR="$FRAMEWORK_ROOT/templates"
CHANGED=0

# Agents and their template type (parallel arrays — bash 3.2 compatible).
AGENTS=(kaptein leon-kaptein max-personal leon-personal nordflo-dev massivlust-dev)
TEMPLATES=(orchestrator orchestrator agent agent agent agent)

# 1. Clean up stale heartbeat/check-approvals crons from all agents
i=0
while [ $i -lt ${#AGENTS[@]} ]; do
  AGENT="${AGENTS[$i]}"
  FILE="$AGENTS_DIR/$AGENT/config.json"
  if [ -f "$FILE" ]; then
    BEFORE=$(jq '.crons | length' "$FILE")
    jq '.crons = (.crons | map(select(.name != "heartbeat" and .name != "check-approvals")))' "$FILE" > /tmp/c.json && mv /tmp/c.json "$FILE"
    AFTER=$(jq '.crons | length' "$FILE")
    if [ "$BEFORE" != "$AFTER" ]; then
      echo "  $AGENT: removed heartbeat/check-approvals crons ($BEFORE -> $AFTER)"
      CHANGED=1
    fi
  fi
  i=$((i + 1))
done

# 2. Add nightly-compact to orchestrators (staggered)
for AGENT in kaptein leon-kaptein; do
  FILE="$AGENTS_DIR/$AGENT/config.json"
  if [ -f "$FILE" ]; then
    HAS=$(jq '[.crons[]?.name] | any(. == "nightly-compact")' "$FILE")
    if [ "$HAS" = "false" ]; then
      if [ "$AGENT" = "kaptein" ]; then
        CRON="13 3 * * *"
      else
        CRON="47 3 * * *"
      fi
      jq --arg cron "$CRON" '.crons += [{
        "name":"nightly-compact",
        "type":"recurring",
        "cron": $cron,
        "prompt":"Run /compact to shed accumulated conversation context. Do not do any other work in this invocation - just compact and return to idle."
      }]' "$FILE" > /tmp/c.json && mv /tmp/c.json "$FILE"
      echo "  $AGENT: added nightly-compact cron at $CRON"
      CHANGED=1
    fi
  fi
done

# 3. Refresh AGENTS.md from template (with backup)
i=0
while [ $i -lt ${#AGENTS[@]} ]; do
  AGENT="${AGENTS[$i]}"
  TMPL_NAME="${TEMPLATES[$i]}"
  TMPL="$TEMPLATES_DIR/$TMPL_NAME/AGENTS.md"
  AGENT_FILE="$AGENTS_DIR/$AGENT/AGENTS.md"
  if [ -f "$TMPL" ] && [ -f "$AGENT_FILE" ]; then
    if ! cmp -s "$TMPL" "$AGENT_FILE"; then
      cp "$AGENT_FILE" "$AGENT_FILE.backup-$(date +%Y%m%d)"
      cp "$TMPL" "$AGENT_FILE"
      echo "  $AGENT: AGENTS.md refreshed from $TMPL_NAME template (backup saved)"
      CHANGED=1
    fi
  fi
  i=$((i + 1))
done

echo ""
if [ $CHANGED -eq 1 ]; then
  echo "Changes applied. Restart fleet to pick up:"
  echo "  pm2 kill && cortextos start"
else
  echo "No changes needed - all agents already clean."
fi
