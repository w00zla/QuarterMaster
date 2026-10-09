#!/usr/bin/env bash
# Production database roles (compose.yaml mounts this into /docker-entrypoint-initdb.d/, so it runs
# once on a fresh volume; scripts/deploy.sh runs it again after every migration). Idempotent.
#   qm_owner: owns the database and everything the migrations create; used by "migrate" only
#   qm_app:   DML for bot and admin; app.stock_journal and app.history are append-only (SELECT, INSERT); in schema
#             web only SELECT on the session/token columns without hashes (bot and admin must not forge web sessions)
#   qm_web:   user web app; reads catalog and app, writes users, stock and its shares, journal and history (INSERT only) and
#             blueprints, but not org/member (role IDs, roster); no access to schema bot;
#             full DML in web; reads ext
# Grants for new tables come from default privileges, which only cover objects created BY qm_owner:
# never run migrations as the superuser. They cover qm_app only; qm_web's grants are explicit and
# applied on every run. Dev and test databases have no roles (superuser only).
set -euo pipefail

db=${POSTGRES_DB:-quartermaster}

psql -v ON_ERROR_STOP=1 --username "${POSTGRES_USER:-postgres}" --dbname "$db" \
  -v db="$db" -v owner_pw="${QM_OWNER_PASSWORD:?}" -v app_pw="${QM_APP_PASSWORD:?}" \
  -v web_pw="${QM_WEB_PASSWORD:?}" <<'SQL'
SELECT 'CREATE ROLE qm_owner' WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'qm_owner') \gexec
SELECT 'CREATE ROLE qm_app' WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'qm_app') \gexec
SELECT 'CREATE ROLE qm_web' WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'qm_web') \gexec
-- Also applies a changed password from .env
ALTER ROLE qm_owner WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS PASSWORD :'owner_pw';
ALTER ROLE qm_app WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS PASSWORD :'app_pw';
ALTER ROLE qm_web WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS PASSWORD :'web_pw';

-- The owner may create schemas (the migrations do)
ALTER DATABASE :"db" OWNER TO qm_owner;
REVOKE ALL ON DATABASE :"db" FROM PUBLIC;
GRANT CONNECT ON DATABASE :"db" TO qm_app, qm_web;

ALTER DEFAULT PRIVILEGES FOR ROLE qm_owner GRANT USAGE ON SCHEMAS TO qm_app;
ALTER DEFAULT PRIVILEGES FOR ROLE qm_owner GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO qm_app;
ALTER DEFAULT PRIVILEGES FOR ROLE qm_owner GRANT USAGE, SELECT ON SEQUENCES TO qm_app;

-- Exist only after the migrations. The migration bookkeeping is the owner's alone.
SELECT 'REVOKE UPDATE, DELETE ON app.stock_journal FROM qm_app'
  WHERE to_regclass('app.stock_journal') IS NOT NULL \gexec
SELECT 'REVOKE UPDATE, DELETE ON app.history FROM qm_app'
  WHERE to_regclass('app.history') IS NOT NULL \gexec
SELECT 'REVOKE ALL ON SCHEMA drizzle FROM qm_app' WHERE to_regnamespace('drizzle') IS NOT NULL \gexec
SELECT 'REVOKE ALL ON ALL TABLES IN SCHEMA drizzle FROM qm_app' WHERE to_regnamespace('drizzle') IS NOT NULL \gexec
-- Web sessions are the user web app's alone
SELECT 'REVOKE ALL ON SCHEMA web FROM qm_app' WHERE to_regnamespace('web') IS NOT NULL \gexec
SELECT 'REVOKE ALL ON ALL TABLES IN SCHEMA web FROM qm_app' WHERE to_regnamespace('web') IS NOT NULL \gexec
-- ... except reading who logged in when and under which Discord name, and whether a companion token exists
-- (the admin's user overview): single columns, never the token hashes
SELECT 'GRANT USAGE ON SCHEMA web TO qm_app' WHERE to_regnamespace('web') IS NOT NULL \gexec
SELECT 'GRANT SELECT (user_id, discord_username, discord_global_name, created_at, last_seen_at, expires_at) ON web.session TO qm_app'
  WHERE to_regclass('web.session') IS NOT NULL \gexec
SELECT 'GRANT SELECT (user_id, discord_username, discord_global_name, created_at, last_used_at) ON web.api_token TO qm_app'
  WHERE to_regclass('web.api_token') IS NOT NULL \gexec

-- qm_web, explicit (also exist only after the migrations). Schema-wide grants pick up new tables
-- because this script runs after every migration. No grants on drizzle.
SELECT format('GRANT USAGE ON SCHEMA %I TO qm_web', s) FROM unnest(ARRAY['catalog', 'app', 'web', 'ext']) s
  WHERE to_regnamespace(s) IS NOT NULL \gexec
SELECT format('GRANT SELECT ON ALL TABLES IN SCHEMA %I TO qm_web', s) FROM unnest(ARRAY['catalog', 'app', 'ext']) s
  WHERE to_regnamespace(s) IS NOT NULL \gexec
-- app.org and app.member stay read-only: role IDs and the roster come from the bot
SELECT 'GRANT INSERT, UPDATE ON app.app_user TO qm_web' WHERE to_regclass('app.app_user') IS NOT NULL \gexec
SELECT 'GRANT INSERT, UPDATE, DELETE ON app.stock_batch TO qm_web'
  WHERE to_regclass('app.stock_batch') IS NOT NULL \gexec
SELECT 'GRANT INSERT, DELETE ON app.stock_share TO qm_web' WHERE to_regclass('app.stock_share') IS NOT NULL \gexec
SELECT 'GRANT INSERT ON app.stock_journal TO qm_web' WHERE to_regclass('app.stock_journal') IS NOT NULL \gexec
SELECT 'GRANT INSERT ON app.history TO qm_web' WHERE to_regclass('app.history') IS NOT NULL \gexec
SELECT 'GRANT INSERT, DELETE ON app.user_blueprint TO qm_web'
  WHERE to_regclass('app.user_blueprint') IS NOT NULL \gexec
-- Nothing from bot (it read bot.guild until migration 0018): taken back where an older run granted it
SELECT 'REVOKE ALL ON ALL TABLES IN SCHEMA bot FROM qm_web' WHERE to_regnamespace('bot') IS NOT NULL \gexec
SELECT 'REVOKE ALL ON SCHEMA bot FROM qm_web' WHERE to_regnamespace('bot') IS NOT NULL \gexec
SELECT 'GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA web TO qm_web'
  WHERE to_regnamespace('web') IS NOT NULL \gexec
SQL
