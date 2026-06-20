#!/bin/bash
set -e
cd "$(dirname "$0")/.."
echo "=== Backfill ALL jobs ==="
node src/index.js --mode=backfill "$@"
