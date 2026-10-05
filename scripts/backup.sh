#!/usr/bin/env bash
# Database backup (run on the VM, from the checkout; daily via deploy/quartermaster-backup.timer):
# pg_dump into $BACKUP_DIR (default: backups/ in the checkout), copy to the target, then delete
# local dumps older than $KEEP_DAYS days (default 14; deploy.sh's dumps too).
# The target is anything rsync accepts (/mnt/backup/qm/, user@host:qm/). Nothing is deleted
# there: retention on the target is the target's business.
#
#   scripts/backup.sh <target>
set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "Usage: $0 <rsync target>" >&2
  exit 1
fi
target=$1

cd "$(dirname "$0")/.."
BACKUP_DIR=${BACKUP_DIR:-backups}
KEEP_DAYS=${KEEP_DAYS:-14}

# The dump holds user data: readable by the owner only
umask 077
mkdir -p "$BACKUP_DIR"
backup="$BACKUP_DIR/quartermaster-$(date +%Y%m%d-%H%M%S).dump"

# Dump into a temporary file: a failed dump must not leave a complete-looking file behind
trap 'rm -f "$backup.part"' EXIT
docker compose exec -T db pg_dump -U postgres -d quartermaster --format=custom > "$backup.part"
mv "$backup.part" "$backup"
echo "Dump: $backup ($(du -h "$backup" | cut -f1))"

rsync --archive "$backup" "$target"
echo "Copied to $target"

# Only after the copy: a failing target must not cost local dumps
find "$BACKUP_DIR" -maxdepth 1 -name 'quartermaster-*.dump' -mtime +"$KEEP_DAYS" -delete
