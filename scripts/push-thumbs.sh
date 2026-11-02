#!/usr/bin/env bash
# Copies the item thumbnails from local/thumbs/ (pnpm thumbs:build) into the VM's checkout: the image files
# first (one tar stream over ssh, into the existing directory: the container's bind mount stays valid), then
# the manifest under a temporary name and renamed (the web app never reads a half-written one), then the
# files the manifest no longer names are deleted. The file names carry a content hash: clients keep
# what did not change.
#
#   scripts/push-thumbs.sh <user@host>
#
# DEPLOY_PATH: the checkout on the VM (default /opt/sc-quartermaster).
set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "Usage: $0 <user@host>" >&2
  exit 1
fi
host=$1
path=${DEPLOY_PATH:-/opt/sc-quartermaster}

cd "$(dirname "$0")/.."
dir=local/thumbs
manifest=$dir/thumbs.json

if [[ ! -f $manifest ]]; then
  echo "No $manifest (pnpm thumbs:build)" >&2
  exit 1
fi
for size in s m l; do
  if [[ ! -d $dir/$size ]]; then
    echo "Missing $dir/$size" >&2
    exit 1
  fi
done

remote="$path/$dir"
count=$(find "$dir/s" "$dir/m" "$dir/l" -type f -name '*.avif' | wc -l)
echo "==> $count thumbnails to $host:$remote"
# shellcheck disable=SC2029 # $remote is meant to expand here, on the client
tar -C "$dir" -cf - s m l | ssh "$host" "mkdir -p '$remote' && tar -C '$remote' -xf -"
scp "$manifest" "$host:$remote/thumbs.json.new"
# Then: the manifest in place, and away with every image it does not name (old hashes, gone UUIDs)
# shellcheck disable=SC2029
ssh "$host" "cd '$remote' && mv thumbs.json.new thumbs.json \
  && grep -oE '\"[0-9a-f-]{36}\":\"[0-9a-f]{8}\"' thumbs.json | tr -d '\"' | sed -E 's/^(.*):(.*)$/\1.\2.avif/' > .keep \
  && find s m l -type f -name '*.avif' | grep -vFf .keep | xargs -r rm --; rm -f .keep"
echo "==> Done: the web app picks the manifest up within seconds"
