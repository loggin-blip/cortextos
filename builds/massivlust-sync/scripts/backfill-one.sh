#!/bin/bash
set -e
cd "$(dirname "$0")/.."
if [ -z "$1" ]; then
  echo "Usage: $0 <source> [--dry-run]"
  echo "Sources: tripletex-timer, tripletex-fakturaer, tripletex-employees, tripletex-projects,"
  echo "         gmail-korrespondanse, drive-bilder, drive-ifc, calendar-events, progress-aggregator"
  exit 1
fi
echo "=== Backfill: $1 ==="
node src/index.js --mode=backfill --source="$1" "${@:2}"
