# User web app: plan

Status: steps 1–3 built plus the basic features (stock, refinery, blueprints, crafting, profile, realtime), see
`CLAUDE.md` "Architecture: user web app"; compose service, image and Caddy example built (step 6 in part); open: step 4 (security review), the `qm_web` role test, privacy notice, ZAP scan, the VM deploy. Decisions of 2026-10-05 included. Decisions already taken are in `requirements.md` ("Web apps");
this file holds the plan. Items marked **[decide]** are still open.

## 1. Scope

Alternative to the bot for users: personal stock, blueprints, org stock. Same rights as the bot (stock service
`Actor`, no rights logic of its own).

Part of the scope by earlier decision (memory "officer flag with user web app"):
- `officer boolean` in `app.member`, written by `syncMember` (`setWhere` gets `officer IS DISTINCT FROM`);
- roster freshness per org (`app.org.roster_checked_at`, written by the bot's roster keeper; it replaced the global `bot.heartbeat` of `0003` after the review, migration `0005`); org stock read-only in the web app when it is older than a few minutes;
- first migration under the "PROD migrations are frozen" rule.

Feature cut (decided), in this order:
1. foundation only (login, session, logout, "who am I", my orgs) — security review before anything else;
2. read views: personal stock, org stock (list/find), my blueprints;
3. writes: stock add/remove/move/adjust, blueprints add/remove; refinery (built in the web app as work orders with
   several ores, refinery locations and yield bonuses from UEX; the bot's `/qm-refinery` is still open).

GUI language (decided): de/en like the bot, picked from `navigator.language` with a manual switch.

## 2. Architecture

- **Own process** `src/webapp/main.ts` (Hono, like the admin), own compose service `webapp`, published on
  `127.0.0.1:3000` (the port reserved for it). Caddy serves it on 443 of the main host name.
- **Own SPA** package `webapp/` (Vue 3 + Vite, like `adminapp/`). No admin code in the user bundle.
  Building blocks (decided): from the admin SPA, imported relatively from `adminapp/src/` (`Dropdown`, `ColumnHead`,
  `tableColumns.ts`, `Tooltip`, `HelpTip`, `Icon`, styles), plus components from BindSight
  (`/mnt/DATA/Projects/_sc/bindsight/`, MIT, own project) that the admin lacks — candidates `ConfirmDialog`
  (confirmation before remove/move/adjust), `Toasts`; copied into this repo (the Docker build only sees this
  checkout), adapted where they touch Tauri.
- The admin UI stays as it is (basic auth, `:8443`). It is not reachable through the user app.
- Locally: admin keeps `:3000`; the user app backend runs on `:3002`, its Vite on `:5174` with a proxy for
  `/api` and `/auth` to `:3002`. Status: steps 1–3 built, see CLAUDE.md "Architecture: user web app".

## 3. Data model (migration `0003`)

- `app.member.officer boolean NOT NULL DEFAULT false` + `syncMember` change (see 1).
- `bot.heartbeat` (one row: `at timestamptz`), written by the bot every 60 s while the gateway is ready.
- New schema **`web`** (web-only state, like `bot`; `app` never references it):
  - `web.session`: `id_hash bytea PK` (SHA-256 of the token), `user_id text` (snowflake CHECK, **no FK**),
    `created_at`, `last_seen_at`, `expires_at`, `user_agent text` (for a "your sessions" list later, optional).
    Expired rows are deleted (by the app, on access and periodically). This is ephemeral state, not app data,
    so "nothing is deleted" does not apply.
- No Discord tokens are stored (see 4).

## 4. Login (Discord OAuth2)

- **Authorization code flow with PKCE (S256) and `state`**, confidential client (secret on the server only).
  Library: **`openid-client`** (decided 2026-10-05; `arctic` turned out to be deprecated on npm since 2026-07),
  Discord endpoints configured by hand.
- Scope **`identify` only**. Membership and officer flag come from the roster, never from Discord at request time.
- `GET /auth/login`: random `state` + `code_verifier`, both in one short-lived cookie
  (`__Host-qm_oauth`, HttpOnly, Secure, **SameSite=Lax** — Strict would not be sent on the return from
  discord.com — Max-Age 10 min), then redirect to Discord.
- `GET /auth/callback`: compare `state`, exchange the code, `GET /users/@me` once, **discard the access token**
  (no refresh token kept: nothing to leak, nothing to rotate). Upsert `app_user`, create a new session
  (never reuse one: no session fixation), clear the OAuth cookie, redirect to `/`.
- The redirect URI is `WEBAPP_ORIGIN` + `/auth/callback` (one variable, also the origin for the CSRF check),
  **never from the Host header**.
- No "return to" target after login (always `/`): no open redirect surface. Can come later as relative paths only.
- `POST /auth/logout`: deletes the session row and the cookie.

## 5. Sessions

- Token: 32 random bytes (`crypto.randomBytes`), base64url, in cookie **`__Host-qm_session`**
  (HttpOnly, Secure, SameSite=Lax, Path=/, no Domain). The DB stores only its SHA-256: a DB dump yields
  no usable sessions. This is the pattern of the Lucia guide (Lucia itself is deprecated, the guide is the
  recommendation); about 60 lines, no library.
- Lifetime (decided): 14 days idle (sliding, `last_seen_at` updated at most once an hour), absolute cap 30 days.
- Every request resolves user → `app_user` upsert if missing (decided) → active `member` rows with officer
  flag from the DB. **Nothing about rights is cached in the session**: losing a role takes effect with the next
  roster sync.
- `Secure`/`__Host-` work on `http://localhost` in Chrome and Firefox: no dev-only cookie branch.

## 6. Measures per attack vector

| Vector | Measure |
|---|---|
| CSRF | Session cookie SameSite=Lax; Hono `csrf()` (checks Origin / `Sec-Fetch-Site`); **mutations accept `application/json` only** (Hono's `csrf()` only checks form/text content types; a JSON body cross-origin needs a CORS preflight, which we never answer); no state change on GET. Same-site is not enough here: admin (`:8443`) and user app are the same *site*. |
| XSS | Vue escapes by default; **no `v-html`** (enforced by a test that greps the SPA sources; the only exception is `Icon.vue`, which renders constants). Untrusted texts: external `global.ini` files, Discord display names. Strict CSP from the app (Hono `secureHeaders`): `default-src 'self'; script-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'; img-src 'self' data: https://cdn.discordapp.com`, try without `style-src 'unsafe-inline'` (Vue's `:style` uses CSSOM, which CSP allows). |
| Clickjacking | `frame-ancestors 'none'`. |
| Broken access control / IDOR | `Actor` built only from the session + roster; a `guildId` from the request is accepted only if the user has an active member row there. Reads go through functions that take the `Actor` (like `pickableBatches`), never "load by ID". Writes through the stock service only. Heartbeat guard **enforced on the server** (org writes refused), not just greyed out. **Authorization test matrix** (DB tests): other user's personal stock, other org, member vs. officer, inactive member, stale heartbeat. |
| Missing auth on a route | Auth middleware on everything except `/auth/*` and static files; a test lists all registered routes and asserts 401 without a session. |
| Injection | drizzle / `sql` templates are parameterized; no `sql.raw` with input (grep test). Zod for every body/query/param; `bodyLimit` small (e.g. 16 KB). Amounts via `parseAmount`. |
| Token / session theft | HttpOnly, Secure, HSTS (Caddy, host-wide already), hashed tokens in the DB, no Discord tokens stored, `Referrer-Policy: no-referrer` (the callback URL carries the code), `Cache-Control: no-store` on API responses. |
| Brute force / abuse | Rate limit in the app (in memory, one process): `/auth/*` per IP, API per session. Client IP from `X-Forwarded-For`: Caddy ignores incoming values from clients by default and sets its own, the app is reachable via loopback only, so it is trustworthy. Library (decided): `hono-rate-limiter`. |
| Privilege escalation via the DB | **Own DB role `qm_web`** (decided) instead of `qm_app`: SELECT on `catalog`, `app.org`, `app.member`, from `bot` only `bot.guild(guild_id, left_at)`; DML on `app.stock_batch`, `app.user_blueprint`, `app.app_user` (INSERT/UPDATE), `web.*`; `app.stock_journal` SELECT/INSERT. No write access to `app.org` (role IDs!), `app.member`, `bot.*`. A compromised web app then cannot make itself officer. Costs explicit grants in `deploy/db-roles.sh` (default privileges cover `qm_app` only). |
| Information leaks | Generic error responses, stack traces in the log only; logs never contain cookies, codes, tokens. Auth events (login, logout, failed state check) logged with user ID and IP. |
| Secrets | `DISCORD_CLIENT_SECRET` only in the `webapp` container; no bot token there. |
| CORS | No CORS middleware at all (same origin only). |
| Dependencies | Lockfile as now; `pnpm audit --prod` as a manual step before a deploy (decided, in `deploy.md`). pnpm 10 already blocks dependency install scripts. Image updates via `build --pull` (exists). |
| Container | Same hardening as `admin` (read-only, `cap_drop: ALL`, `no-new-privileges`, log rotation). |

Not planned: a dev-mode login bypass. If testing several roles with one Discord account becomes a pain, a
dev-only "log in as" is possible later, gated by an env flag **and** refusing to start on a non-loopback host.

## 7. Development and tests

- Dev Discord application (exists): OAuth2 redirect `http://localhost:5174/auth/callback`, client secret into
  `.env` (`DISCORD_CLIENT_SECRET`, `OAUTH_REDIRECT_URI`; client ID = `DISCORD_APP_ID`). Prod application: only
  the HTTPS redirect. Always `localhost`, never `127.0.0.1` in the browser (different cookie host).
- The dev bot must run against the dev DB, otherwise the roster is empty (personal stock still works).
- Tests create sessions directly through a helper (no Discord). The OAuth callback is tested with a stubbed
  token/user endpoint (arctic takes the endpoints from the provider; stub via `fetch`).
- Before go-live: OWASP ZAP baseline scan against the local instance (decided).

## 8. Deployment

- `compose.yaml`: service `webapp` (`127.0.0.1:3000:3000`), env `DATABASE_URL` (role `qm_web`),
  `DISCORD_APP_ID`, `DISCORD_CLIENT_SECRET`, `OAUTH_REDIRECT_URI`.
- Caddy: site block for the main host name (443) → `127.0.0.1:3000`, HSTS; the other security headers come from
  the app (testable, also in dev).
- `deploy.sh`: stops/starts `webapp` with bot/admin around the migration.
- **Privacy notice** (decided, needed before go-live): a public site with Discord login processes personal data
  (Discord ID, name, IP in logs). No imprint for now (decided).
- No Cloudflare (decided): home hosting with its own DNS/reverse proxy setup.

## 9. Order of work (each step: draft → go → build → test → go → commit)

1. Migration `0003` (officer, heartbeat, `web.session`) + `syncMember` + heartbeat in the bot + DB role.
2. Backend foundation: Hono app, headers, CSRF, rate limit, OAuth, sessions, `/api/me`, tests (incl. route/auth test).
3. SPA skeleton: login, logout, layout, my orgs.
4. Security review of 1–3 (`/security-review`), dev OAuth test end to end.
5. Read views, then writes (with the authorization matrix growing per endpoint).
6. Compose/Caddy/deploy, privacy notice, ZAP scan, go-live.
