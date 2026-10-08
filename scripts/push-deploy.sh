#!/usr/bin/env bash
# Deploys the committed main branch from this machine: pushes into the VM's checkout over SSH,
# then runs scripts/deploy.sh there. The VM's checkout is a plain repo created with
# "git init -b main" and "git config receive.denyCurrentBranch updateInstead"; there is no
# git server, the VM never pulls.
#
#   scripts/push-deploy.sh <user@host>
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

# Only commits are pushed: a changed or never added file (e.g. a new migration) would silently
# be missing on the VM
if [[ -n $(git status --porcelain) ]]; then
  echo "Uncommitted or untracked files, commit or remove them first:" >&2
  git status --short >&2
  exit 1
fi
branch=$(git symbolic-ref --quiet --short HEAD || true)
if [[ $branch != main ]]; then
  echo "Not on main (on: ${branch:-detached HEAD})" >&2
  exit 1
fi

echo "==> Push $(git rev-parse --short HEAD) to $host:$path"
git push "$host:$path" main

echo "==> Deploy on $host"
# -t: live output, Ctrl+C reaches the VM. A dropped connection kills deploy.sh; it can simply be
# run again (a migration rolls back as a whole, bot/admin/ext/webapp stay stopped until then).
# shellcheck disable=SC2029  # the path is meant to expand here, quoted for the remote shell
ssh -t "$host" "cd $(printf %q "$path") && scripts/deploy.sh"
