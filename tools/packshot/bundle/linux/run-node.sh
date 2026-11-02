#!/usr/bin/env bash
# Starts packshot as a node: renders the blocks of the coordinators in packshot.json until Ctrl+C.
# Further arguments go to packshot (e.g. --workers 6).
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

if [ ! -x ./blender/blender ]; then
  echo "ERROR: no Blender in ./blender: run bash setup.sh first" >&2
  exit 1
fi
if [ ! -f packshot.json ]; then
  echo "ERROR: packshot.json is missing: cp packshot.example.json packshot.json, then set token and coordinators" >&2
  exit 1
fi

exec ./packshot --node "$@"
