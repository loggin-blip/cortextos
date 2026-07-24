#!/bin/bash
# Standalone draft-complete notifier loop — polls every 30s, zero Claude tokens.
# Managed by PM2. Sends DRAFT_COMPLETE to personal agent when gmail-drafter finishes.

SCRIPT="/Users/max/cortextos/scripts/massivlust/draft-complete-notifier.py"
LOG_DIR="/Users/max/.cortextos/default/logs/draft-complete-notifier"
mkdir -p "$LOG_DIR"

while true; do
    python3 "$SCRIPT" >> "$LOG_DIR/notifier.log" 2>&1
    sleep 30
done
