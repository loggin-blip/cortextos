#!/usr/bin/env bash
# Stop the jensen-inspector server.
set -euo pipefail
for port in 4747 4748; do
  pids=$(lsof -ti ":${port}" 2>/dev/null || true)
  if [[ -n "${pids}" ]]; then
    echo "stopping pid(s) on :${port} -> ${pids}"
    kill ${pids} || true
  fi
done
echo "done."
