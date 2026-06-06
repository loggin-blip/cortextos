#!/usr/bin/env bash
# restart-watchdog.sh — run BEFORE pm2 kill. Waits, restarts, verifies.
set -eo pipefail
echo "[watchdog] Killing daemon..."
pm2 kill
sleep 5
echo "[watchdog] Starting cortextos..."
cortextos start
sleep 10
echo "[watchdog] Verifying..."
cortextos status
echo "[watchdog] Done."
