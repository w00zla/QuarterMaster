#!/usr/bin/env bash
# Local Postgres for development and tests (Podman).
set -euo pipefail

CONTAINER=sc-quartermaster-pg
VOLUME=sc-quartermaster-pg-data
IMAGE=docker.io/library/postgres:18
PORT=${PG_PORT:-5432}
USER_NAME=quartermaster
DB_NAME=quartermaster
TEST_DB_NAME=quartermaster_test

wait_ready() {
  for _ in $(seq 1 30); do
    if podman exec "$CONTAINER" pg_isready -U "$USER_NAME" -d "$DB_NAME" >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  echo "Postgres did not become ready" >&2
  return 1
}

case "${1:-}" in
  up)
    if podman container exists "$CONTAINER"; then
      podman start "$CONTAINER" >/dev/null
    else
      podman run -d --name "$CONTAINER" \
        -e POSTGRES_USER="$USER_NAME" \
        -e POSTGRES_PASSWORD="$USER_NAME" \
        -e POSTGRES_DB="$DB_NAME" \
        -p "127.0.0.1:${PORT}:5432" \
        -v "${VOLUME}:/var/lib/postgresql" \
        "$IMAGE" >/dev/null
    fi
    wait_ready
    if ! podman exec "$CONTAINER" psql -U "$USER_NAME" -d "$DB_NAME" -tAc \
      "SELECT 1 FROM pg_database WHERE datname = '${TEST_DB_NAME}'" | grep -q 1; then
      podman exec "$CONTAINER" createdb -U "$USER_NAME" "$TEST_DB_NAME"
    fi
    echo "Postgres up on 127.0.0.1:${PORT} (databases: ${DB_NAME}, ${TEST_DB_NAME})"
    ;;
  down)
    podman stop "$CONTAINER" >/dev/null
    echo "Postgres stopped (data kept in volume ${VOLUME})"
    ;;
  psql)
    shift
    podman exec -it "$CONTAINER" psql -U "$USER_NAME" -d "${1:-$DB_NAME}"
    ;;
  *)
    echo "Usage: $0 up|down|psql [database]" >&2
    exit 1
    ;;
esac
