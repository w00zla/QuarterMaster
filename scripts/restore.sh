#!/usr/bin/env bash
# Restore a dump into a fresh database volume (run on the VM, from the checkout; docs/deploy.md § 10).
# DELETES the current database: stop bot/admin/ext/webapp -> remove db and its volume -> fresh db
# (the init creates the roles) -> pg_restore -> migrate -> DB roles -> start everything.
#
#   scripts/restore.sh backups/<dump>
set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "Usage: $0 <dump>" >&2
  exit 1
fi
dump=$(realpath "$1")
[[ -f $dump ]] || { echo "No such file: $1" >&2; exit 1; }

cd "$(dirname "$0")/.."
VOLUME=sc-quartermaster_pgdata

read -r -p "This deletes the current database ($VOLUME) and restores $dump. Type 'yes': " answer
[[ $answer == yes ]] || { echo "Aborted"; exit 1; }

echo "==> Stop bot, admin, ext and webapp"
docker compose stop bot admin ext webapp

echo "==> Remove db and its volume"
docker compose rm -sf db
docker volume rm "$VOLUME"

echo "==> Fresh db (creates the roles)"
docker compose up -d --wait db

echo "==> Restore $dump"
docker compose exec -T db pg_restore -U postgres -d quartermaster --exit-on-error < "$dump"

echo "==> Migrate"
docker compose run --rm migrate

# After the migration, as in deploy.sh: qm_web's grants are explicit and miss what the migration created
echo "==> DB roles"
docker compose exec -T db bash -s < deploy/db-roles.sh

echo "==> Start"
docker compose up -d
