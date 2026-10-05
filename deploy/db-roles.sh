#!/usr/bin/env bash
# Production database roles (compose.yaml mounts this into /docker-entrypoint-initdb.d/, so it runs
# once on a fresh volume; scripts/deploy.sh runs it again after every migration). Idempotent.
#   qm_owner: owns the database and everything the migrations create; used by "migrate" only
#   qm_app:   DML for bot and admin; app.stock_journal is append-only (SELECT, INSERT)
# Grants for new tables come from default privileges, which only cover objects created BY qm_owner:
# never run migrations as the superuser. Dev and test databases have no roles (superuser only).
set -euo pipefail

db=${POSTGRES_DB:-quartermaster}

psql -v ON_ERROR_STOP=1 --username "${POSTGRES_USER:-postgres}" --dbname "$db" \
  -v db="$db" -v owner_pw="${QM_OWNER_PASSWORD:?}" -v app_pw="${QM_APP_PASSWORD:?}" <<'SQL'
SELECT 'CREATE ROLE qm_owner' WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'qm_owner') \gexec
SELECT 'CREATE ROLE qm_app' WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'qm_app') \gexec
-- Also applies a changed password from .env
ALTER ROLE qm_owner WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS PASSWORD :'owner_pw';
ALTER ROLE qm_app WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS PASSWORD :'app_pw';

-- The owner may create schemas (the migrations do)
ALTER DATABASE :"db" OWNER TO qm_owner;
REVOKE ALL ON DATABASE :"db" FROM PUBLIC;
GRANT CONNECT ON DATABASE :"db" TO qm_app;

ALTER DEFAULT PRIVILEGES FOR ROLE qm_owner GRANT USAGE ON SCHEMAS TO qm_app;
ALTER DEFAULT PRIVILEGES FOR ROLE qm_owner GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO qm_app;
ALTER DEFAULT PRIVILEGES FOR ROLE qm_owner GRANT USAGE, SELECT ON SEQUENCES TO qm_app;

-- Exist only after the migrations. The migration bookkeeping is the owner's alone.
SELECT 'REVOKE UPDATE, DELETE ON app.stock_journal FROM qm_app'
  WHERE to_regclass('app.stock_journal') IS NOT NULL \gexec
SELECT 'REVOKE ALL ON SCHEMA drizzle FROM qm_app' WHERE to_regnamespace('drizzle') IS NOT NULL \gexec
SELECT 'REVOKE ALL ON ALL TABLES IN SCHEMA drizzle FROM qm_app' WHERE to_regnamespace('drizzle') IS NOT NULL \gexec
SQL
