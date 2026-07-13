#!/bin/zsh
# ── Agent-engine tick ────────────────────────────────────────────────────────
# Kjøres av launchd (com.cortextos.agent-engine) hvert minutt:
#   1) apply-agent-intents.mjs — utfør dashbordets køede endringer på de ekte
#      cortextOS-filene (config.json/.md), og speil tilbake ved endring.
#   2) sync-agent-config.mjs   — fang opp endringer gjort direkte på Studio.
#   3) sync-agent-files.mjs    — speil agentenes fil-tre + kjerne-innhold (Kontekst-fanen).
#   4) sync-agent-runtime.mjs  — speil live runtime-puls (heartbeat/kontekst/krasj — Statistikk).
#   5) sync-agent-approvals.mjs — speil godkjenn-forespørsler (Godkjenninger-innboksen).
#   6) engine-heartbeat.mjs    — «motoren lever»-tidsstempel (helse-indikator i dashbordet).
# Loggen trimmes til siste 2000 linjer. Isolert fra dashbord-checkouten.
export PATH=/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin
cd "$HOME/cortextos/agent-engine" || exit 1
mkdir -p logs
{
  echo "── tick $(date '+%Y-%m-%d %H:%M:%S') ──"
  node scripts/apply-agent-intents.mjs
  node scripts/sync-agent-config.mjs
  node scripts/sync-agent-files.mjs
  node scripts/sync-agent-runtime.mjs
  node scripts/sync-agent-approvals.mjs
  node scripts/engine-heartbeat.mjs
} >> logs/engine.log 2>&1
tail -n 2000 logs/engine.log > logs/engine.log.tmp 2>/dev/null && mv logs/engine.log.tmp logs/engine.log
