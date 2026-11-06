#!/usr/bin/env bash
# Copies the companion app release from local/companion/ into the VM's checkout, the manifest last:
# scripts/push-companion.mjs does it (the one push implementation, also behind publish-win-companion.ps1).
#
#   scripts/push-companion.sh <user@host>
#
# Environment (same names as in sc-quartermaster): DEPLOY_PATH, COMPANION_DIR (see push-companion.mjs).
set -euo pipefail
exec node "$(dirname "$0")/push-companion.mjs" "$@"
