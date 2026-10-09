#!/usr/bin/env bash
# Runs the DB tests with the production roles (test/roles.ts, deploy/db-roles.sh) against the dev container
# from scripts/dev-db.sh: migrations as qm_owner, the code under test as qm_app or qm_web.
# Arguments go to the test runner, e.g. scripts/test-roles.sh test/stock.db.test.ts
# The tests drop and recreate the schemas of TEST_DATABASE_URL, and the roles script changes the owner of
# that database and creates the cluster roles qm_owner, qm_app and qm_web.
set -euo pipefail

cd "$(dirname "$0")/.."
container=sc-quartermaster-pg

# deploy/db-roles.sh calls psql: there is none on the host, so a wrapper runs the container's
shim=$(mktemp -d)
trap 'rm -rf "$shim"' EXIT
cat >"$shim/psql" <<SH
#!/usr/bin/env bash
exec podman exec -i $container psql "\$@"
SH
chmod +x "$shim/psql"

export PATH="$shim:$PATH"
export TEST_ROLES=1
if [[ $# -eq 0 ]]; then
  exec pnpm test
fi
exec node --env-file-if-exists=.env --test --test-concurrency=1 "$@"
