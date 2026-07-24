#!/bin/bash
# Standalone inbox monitor loop — runs every 15 min, zero Claude tokens.
# Managed by PM2. Replaces kaptein-massivlust inbox-monitor crons.

SCRIPT="/Users/max/cortextos/scripts/massivlust/inbox-monitor-standalone.py"
LOG_DIR="/Users/max/.cortextos/default/logs/inbox-monitor"
mkdir -p "$LOG_DIR"

while true; do
    TS=$(date '+%Y-%m-%d %H:%M:%S')

    # Martin inbox
    python3 "$SCRIPT" --user martin@massivlust.no >> "$LOG_DIR/martin.log" 2>&1
    MARTIN_EXIT=$?

    sleep 5

    # Alex inbox
    python3 "$SCRIPT" --user alex@massivlust.no >> "$LOG_DIR/alex.log" 2>&1
    ALEX_EXIT=$?

    sleep 5

    # Eivind inbox
    python3 "$SCRIPT" --user eivind@massivlust.no >> "$LOG_DIR/eivind.log" 2>&1
    EIVIND_EXIT=$?

    sleep 5

    # Vegard inbox
    python3 "$SCRIPT" --user vegard@massivlust.no >> "$LOG_DIR/vegard.log" 2>&1
    VEGARD_EXIT=$?

    if [ $MARTIN_EXIT -ne 0 ] || [ $ALEX_EXIT -ne 0 ] || [ $EIVIND_EXIT -ne 0 ] || [ $VEGARD_EXIT -ne 0 ]; then
        echo "$TS ERROR martin=$MARTIN_EXIT alex=$ALEX_EXIT eivind=$EIVIND_EXIT vegard=$VEGARD_EXIT"
    fi

    # Sleep 15 minutes
    sleep 900
done
