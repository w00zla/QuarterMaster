#!/usr/bin/env bash
# Production update with Docker Compose (run on the VM, from the checkout, after a push; scripts/push-deploy.sh does both):
# backup -> keep the running image as :previous -> build (with the latest Node base image) and
# pull Postgres -> stop bot/admin/ext -> migrate -> DB roles (deploy/db-roles.sh) -> start.
# A failed migration leaves the DB unchanged (all pending migrations run in one transaction):
# the script then starts the previous image again.
# Backups go to $BACKUP_DIR (default: backups/ in the checkout, gitignored).
set -euo pipefail

cd "$(dirname "$0")/.."
BACKUP_DIR=${BACKUP_DIR:-backups}
IMAGE=sc-quartermaster

# The dump holds user data: readable by the owner only
umask 077
mkdir -p "$BACKUP_DIR"
backup="$BACKUP_DIR/quartermaster-$(date +%Y%m%d-%H%M%S).dump"

echo "==> Backup to $backup"
# Also creates the DB on the first deploy
docker compose up -d --wait db
docker compose exec -T db pg_dump -U postgres -d quartermaster --format=custom > "$backup"

previous=false
if docker image inspect "$IMAGE:latest" > /dev/null 2>&1; then
  echo "==> Keep the current image as $IMAGE:previous"
  docker tag "$IMAGE:latest" "$IMAGE:previous"
  previous=true
fi

echo "==> Build and pull"
docker compose build --pull
# Same major version (pinned tag), minor updates only; the container is recreated by "up" below
docker compose pull db

echo "==> Stop bot, admin and ext"
docker compose stop bot admin ext

echo "==> Migrate"
if ! docker compose run --rm migrate; then
  echo "Migration failed. The DB is unchanged (all pending migrations run in one transaction). Backup: $backup" >&2
  if $previous; then
    echo "Starting the previous image again." >&2
    docker tag "$IMAGE:previous" "$IMAGE:latest"
    docker compose up -d
  else
    echo "No previous image: bot, admin and ext stay stopped." >&2
  fi
  exit 1
fi

echo "==> DB roles"
# Grants for tables the migrations just created (e.g. the append-only journal). From the checkout
# via stdin: the container's bind mount of a single file keeps the old version after a push.
docker compose exec -T db bash -s < deploy/db-roles.sh

echo "==> Start"
docker compose up -d
docker compose ps
