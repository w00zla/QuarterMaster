# User web app

The users' alternative to the bot: personal stock, components, refinery jobs, blueprints, org stock, the
crafting check, history; login with Discord. Requirements and display rules: `docs/requirements.md`
"Web apps". Users without any org are first-class: every feature gets their path in the same step.

Status: built (backend, SPA, realtime, the features below, compose service), not live for users yet. Open
before go-live: the privacy notice (needs the controller's name and contact from the user: never invent
it), an OWASP ZAP baseline scan, the deploy (`docs/deploy.md`).

Commands (`pnpm webapp`, `webapp:dev`, …): `CLAUDE.md`. Locally the backend runs on `:3002`, its Vite on
`:5174` with a proxy for `/api`, `/auth` and `/downloads`; always open it as `localhost`, never
`127.0.0.1` (another cookie host). The dev Discord application has the redirect
`http://localhost:5174/auth/callback`; the dev bot must run against the dev DB, else the roster is empty.

## Backend (`src/webapp/`)

- Hono, own process (`main.ts`); `createApp` in `app.ts` builds the app without a server, the tests drive it
  via `app.request`.
- Middleware order: `secureHeaders` (strict CSP, no HSTS: Caddy sets it), own same-origin check for every
  non-GET (`Sec-Fetch-Site`, else `Origin` = `WEBAPP_ORIGIN`; Hono's `csrf()` only covers form content
  types), `no-store` on `/auth/*` and `/api/*`, `hono-rate-limiter` (in memory: `/auth/*` per IP, `/api/*`
  per session), then for `/api/*` the session check (401 for every route, unknown ones too), JSON-only
  writes (415) and a 16 KB body limit.
- Client IP: socket address, or the last `X-Forwarded-For` entry with `WEBAPP_TRUST_PROXY=1` (Caddy drops
  the client's own header).

### Login (`discord.ts`)

`openid-client` with hand-configured Discord endpoints (Discord is no OIDC provider; `arctic` was planned
but is deprecated on npm), code + PKCE S256 + state, scope `identify`, redirect URI = `WEBAPP_ORIGIN` +
`/auth/callback` (never from the request). State and verifier sit in the `__Host-qm_oauth` cookie (10 min,
SameSite=Lax: Strict would not be sent on the return from discord.com); the Discord access token is used
once for `/users/@me` and dropped (no refresh token kept). Failures redirect to `/?login=failed|denied`.

Deep links: `/auth/login?returnTo=<path>` keeps the page the login started from (in the OAuth cookie; paths
of this app only, never `//host` or a backslash: no open redirect) and the callback returns there; the
SPA's login button sends the current path and query. The bot links `/stock?scope=<personal|all|guildId>`,
`/blueprints?scope=<personal|guildId>`, `/crafting?add=<uuid>` (`webAppPath` in `src/bot/ui.ts`); each view
reads its parameter once in setup (`takeQuery` in `webapp/src/deepLink.ts`, views only render after the
login) and drops the query from the URL; an org the user is not in falls back to personal.

### Sessions (`session.ts`, `web.session`)

32 random bytes in `__Host-qm_session` (HttpOnly, Secure, SameSite=Lax), only the SHA-256 stored (a dump
yields no usable session); 14 days idle, 30 days absolute; a login replaces this browser's session;
validation re-creates a missing `app_user` row (sessions have no FK to it: the roster cleanup deletes
`app_user` once it holds no data); expired rows deleted hourly. The Discord profile (name, avatar) lives in
the session only, refreshed by each login; `/api/me` returns it for every user, also without any org
(default avatar from the ID). Rights are never cached: `me.ts` reads the roster per request (active member
rows; a server the bot left has none: `markGuildLeft`/`reconcilePresence` deactivate its members).

### Features (`routes.ts`; the contract with all paths and shapes in `api-types.ts`)

- `GET /api/catalog?lang`: bookable materials with unit, the `component` flag, `label`, size, grade letter
  and class, a component's `stats` with bounds, loc `nameKey` and `base`; locations with refinery flag and
  yield bonuses; blueprints; each material and location with its loc `nameKey` (the companion looks it up in
  the player's language pack). From the shared in-memory catalogs; no ores, no refining methods.
- Stock: `/api/stock` personal = everything you own incl. shared, org = what its active members shared (with
  an owner filter), or `all` = both; writes `add`/`remove`/`adjust`/`move` (+ split, merge, share).
- Refinery: `/api/refinery/start|duration|done|remove`, always personal, always a work order: one station
  and an optional duration with 1–30 rows of a refined material, quality and expected yield; `duration` sets
  the time left later (end = now + seconds, null clears; for the companion too); `done` and `remove` take
  exactly the job's batches; yields are corrected through `/api/stock/adjust`.
- Blueprints (own list, add/remove; default and retired refused), org members and their blueprints, owners
  of a blueprint (active members of the same org only); `GET /api/orgs/:g/blueprints`.
- Profile (`POST /api/profile`): RSI handle in `app.app_user`, the web app's own language override in
  `web.user_setting` (the bot keeps its own in `bot.user_config`).
- `GET /api/summary` (overview tiles), `GET /api/info/blueprint|material/:uuid` (info cards),
  `/api/crafting/*` (the admin's catalog queries and `loadPlannerData`), `GET /api/history` (see
  `docs/stock.md` "History").
- Writes go through the stock service with an `Actor` from the roster. `guildId` in a write = the org
  context, needed only to share into it (move) and to give to its members (`toOwnerUserId`), and then you
  must be an active member there (403 `notMember`; the same for every org in add's `guildIds`: shared right
  away, in the same transaction); remove/adjust/split/merge/share take none (your own batch; `share` checks
  each new org in the service). Errors: `{ error: code }` (`HttpError`; stock refusals 422 with the
  service's code). `expected` = the quantity the user saw (`batchChanged`). Lists answer exact decimals
  without trailing zeros and per-material totals (BigInt micro units).

### API token / "Access Key" (`token.ts`, `web.api_token`)

One per user for the companion app, managed in the top bar's "Companion" dialog (`CompanionDialog.vue`;
`POST /api/token`, shown once, only the SHA-256 and the creating session's Discord profile stored; a new one
replaces the old). `Authorization: Bearer qmt_…` authenticates `/api/*` as the user (never falls back to the
cookie) and skips the same-origin check (a cross-site page cannot set the header without a preflight);
`/api/token` itself is session-only. Requests made with it are history source `companion`.

### Companion release (`companion.ts`)

`COMPANION_DIR` (default `local/companion`) holds the built app files and `companion.json`
`{"version":"x.y.z","windows":"<…_x64-standalone.zip>","linux":"<.AppImage>"}` (re-read when it changes).
`GET /api/companion` lists version and downloads; `GET /downloads/companion/<file>` serves only manifest
files, only with a session (else redirect to `/`) or the API token (no version check: the outdated app
downloads its update; a wrong token = 401). Token requests must send `X-QM-Companion: <version>`: older than
the manifest (or missing) = 426 `CompanionOutdated` with the download URLs; no manifest = no check.

### Realtime (`realtime.ts`)

- Triggers (`app.notify_change`) on `member`, `org` (name, roles), `bot.guild` (presence), `stock_batch` and
  `stock_share` (`app.notify_stock`: the owner and every org a batch is shared in), `user_blueprint`,
  `app_user` (RSI handle) send `pg_notify('qm_changes', {t, g, u})` on commit, whoever writes; `app.history`
  inserts (`app.notify_history`) add `id`, `s` (source), `a` (actor), `o` (new owner), `x` (the action) and go
  as `{type:'history', id, source, actor}` to the actor, the owner and the new owner, a `share` also to the
  members of that org.
- The process holds one `LISTEN` (postgres.js, `connect().client`); `RealtimeHub` fans out to the browsers'
  WebSockets on `/api/ws` (`ws` library on Node's `upgrade` event, outside Hono: `@hono/node-ws` only
  supports `@hono/node-server` 1.x). Messages (`ServerMessage`) only say what changed; the SPA refetches
  through the REST endpoints, which keep all rights checks. Routing: personal stock to its owner, org
  stock/roster/org state to the org's active members, blueprints/profile to the user and everyone sharing an
  org; a listener reconnect sends `resync`.
- Handshake checks: path, `Origin` = `WEBAPP_ORIGIN` (cross-site WebSocket hijacking), max 5 sockets per user
  / 20 per address, session cookie; keepalive every 25 s pings and re-validates the session (close code 4401
  when gone). Client messages: JSON `{type:'ping'}` only (Zod), 4 KB, 20 per 10 s, anything else closes
  (1008). Writes stay on REST. CSP `connect-src` lists the ws(s) origin explicitly.

## SPA (`webapp/`)

- Vue 3 + Vite like `adminapp/`, imports the admin's styles and components relatively from `adminapp/src/`
  (no copies; `Icon.vue` is the only `v-html`, constants only, `test/spa-sources.test.ts` enforces it).
  `Picker.vue` has no i18n of its own (the companion imports it): its two texts come via
  `provide(PICKER_LABELS)` in each app's `App.vue`. Shared pure code from `src/` is listed in
  `webapp/tsconfig.json` and Vite `fs.allow` (`src/stock/amount.ts`, `quality.ts`, `src/planner/stock.ts`, …).
- UI texts de/en in `webapp/src/i18n.ts` (same keys enforced by type); language `me.langOverride ??
  navigator.language`, saved via `/api/profile`. `session.ts` holds `/api/me` (401 = login screen); login is
  a plain link to `/auth/login`. The built SPA runs under the strict CSP (no inline scripts or styles;
  checked in Chrome).
- Realtime client `webapp/src/realtime.ts`: reconnect with backoff, reload after a reconnect,
  `onServerMessage` for views; views reload through `coalesced(fn)` (once 300 ms after the last message of a
  burst, at most 3 s after the first, cancelled on unmount); `loadMe` coalesces concurrent reloads.

### Views

- **Übersicht**: KPI tiles from `GET /api/summary`, each with a detail line below (`StatTile`: unit after
  the value, the line as tall as a `.tag`): a personal panel with Materials (SCU materials only; SCU; kinds ·
  locations), Items (pieces; kinds · locations), Components (the same), Blueprints "X / Y" (Y = obtainable:
  not retired, not default, in a reward pool of the game data, cached per import; X = every registered one
  and may exceed Y: then the game data misses a source, listed in the admin overview), Refinery jobs (sum of
  the expected yields · stations) and Next job ready (countdown, a "n ready" tag); "Your orgs" with one
  sub-tile per org (name, state, "Members: n", Resources/Items/Blueprints). Reloads on every realtime message.
- **Bestand** (materials only, no ship components): grouped by material, filters; scope "All" lists personal
  and org stock with an owner column ("Pers." / "Org (holder)"). Adding has a share switch per org (an org
  scope starts with that org on; the batch is always personal, the switches share it). Row actions Sharing (a
  switch per org, whole batch) · Split (unshared) or Merge back (a split-off part) · Move (place, recipient) ·
  Remove · Adjust.
- **Komponenten** (route `/components`, `?scope=` like Bestand; `ComponentsView` = `StockView` with
  `components`): the ship components only, groups named by their `label`, no quality column, filters
  type/size/grade instead of the quality slider; the add form without quality (sends 0) but one slider per
  stat of the picked component from ±0 to its best (`CatalogMaterial.stats`, reset after each add; only gains
  are sent); a Stats column ("Coolant Rating +5.0 % · Integrity +2.0 %", `statsText` in `format.ts`; the
  sliders are `StatSliders.vue`, also in the batch dialog's Adjust, which confirms "from → to"); "Anzahl" in
  pieces instead of "Menge"; `BatchDialog` leaves the quality out (`withQuality`/`qualityPrefix`).
- **Raffinerie**: running jobs as a table with one group per work order (station, total yield and the time
  left with a "ready" tag or "duration open" on the group row; actions: a clock opens `RefineryTimeDialog` to
  set or clear the time left, done, remove with a `ConfirmDialog` listing the materials), the materials below
  with quality, expected yield and UEX bonus; job columns sort the jobs, material columns the materials
  within; same filters as Bestand. `RefineryStartForm`: station, duration (all three fields empty = "duration
  open") and rows of resource, quality and expected yield (no method, no estimates). `RefineryDoneDialog`
  stores the whole job, each row's amount starting from its expected yield.
- **Blueprints**: no "All", the admin's `DataTable` with category/type/size/member filters, names bold; an org
  shows every blueprint its active members registered with who has it. A click on a row puts it into the
  crafting check (`addToCrafting`) and opens the tab.
- **Crafting** (after a divider in the tab bar): `CraftingView`, `CraftingPicker`, `PlanEntryCard`, plan in
  localStorage `qm.webapp.crafting`; the planner's warnings are codes with values (`PlanWarning`), worded by
  `warningText` in `webapp/src/crafting.ts`. Each card has a count (1–99) and per slot a quality slider and
  field that stop at the slot's minimum (`withQualityFloor`; the track keeps the full 0–1000 scale). Below the
  stats a collapsible "Stock" panel (open by default; closed ones in localStorage `qm.webapp.crafting.ui`):
  per material the need (for the card's count) and a chip "covered" / "missing <amount>", then the stored
  batches of that material at or above the card's target quality, own first, then by quality. The stock is
  `GET /api/stock?scope=all`, loaded once per view and on stock/resync messages; each card is checked on its
  own. Pure logic in `src/planner/stock.ts` (shared with `/qm-crafting`), tested in
  `test/crafting-stock.test.ts`.
- **History** (route `/history`, `HistoryView.vue`): see `docs/stock.md` "History".
- Info cards: hovering a blueprint name or a material shows game data from `GET /api/info/...`
  (`InfoTip.vue`: loaded on first hover, cached per language, teleported overlay; never the raw records).
- Profile (RSI handle, language) is a dialog from the settings icon button next to the avatar (the avatar
  itself is not clickable), saved with Save; no language switch in the header.
- Top bar right: History (a route link styled as a button), Companion (`desktop` icon), divider, avatar with
  name, profile, logout (icon only). Footer (from BindSight, one line, sticky): credits, a short CIG fan site
  disclaimer (the full text on hover) and the Star Citizen logo from the official fankit
  (`webapp/src/assets/sc-logo-{20,40}.png`), on every page incl. login.

### Layout and building blocks

- List views share one layout: Bestand and Blueprints have the scope switch above (`ScopeBar.vue`: big
  buttons personal, each org, optionally "All"; always shown, also without any org; `scopeName` for heads),
  then ONE panel: head "<View> · <scope>" with the add button, the add area (`.add-area`), filters, table
  (Raffinerie the same without a scope switch). Never a panel holding only a head (its border doubles the
  panel's).
- Adding (stock add, refinery start, blueprint add) happens in that add area (the head button switches
  plus/close; Clear resets the form; a successful add closes it, except stock add: it stays open and clears
  only quality and amount, the amount back to "1"; the area's title has no line below it, the form's action
  row a dashed one above it, `.form-actions`). Every amount input is `AmountStepper.vue` (minus/plus by one
  SCU or piece, a typed fraction keeps its part, down to `min`); adding books right away with a toast; every
  other action (remove, move, adjust, refinery done, blueprint remove) is confirmed in a dialog first. Stock
  remove/move default to "everything".
- Quality is shown with its level (`qText`/`qMark`; `qMark` in `src/stock/quality.ts`, shared with the bot's
  board): "◌" below 500, one "★" per 100 from 500, "♛" at 1000, no "Q"; table columns use `.qcell` (the level
  right before a fixed four-digit field; a narrow column clips the level, never the value); the quality
  filter is a `RangeSlider` over the tiers (`qTier`/`tierMark`, label "Quality", the qualities in
  parentheses).
- Grid tables (`useTableColumns`/`ColumnHead`): the last non-fixed column is the filler (`fillerKey`: takes
  the space left over, no grip), every grip before it resizes its own column (widening takes the free room
  first, then narrows the resizable columns to its right like Excel, down to 40 px), fixed columns (actions)
  stay at the right edge. Table actions are icon buttons with a tooltip; table filters say "Filter…".
- Dialog buttons always sit in the footer (`ConfirmDialog`); a `ConfirmButton` with `form` submits a form in
  the body (Enter works). Pickers: `webapp/src/components/Picker.vue` (lists every match, the list scrolls);
  `Dropdown.vue` is BindSight's with prefixed variant classes (`dd-chip`, …: ui.css has global
  `.chip`/`.outline`/`.small`). Toasts top right below the top bar (`TopBar.vue` measures its height into
  `layout.ts` `topbarHeight`, `Toasts.vue` sets `top` from it; a CSS variable failed after a full reload).
  Error codes mapped in `i18n.ts`; amounts validated with the server's own `parseAmount`.
- Icons on tabs, buttons and panel heads like BindSight (extra icons in the shared
  `adminapp/src/components/Icon.vue`); no counters in panel heads (only next to filters).

## Security measures

| Vector | Measure |
|---|---|
| CSRF | Session cookie SameSite=Lax; own same-origin check on every non-GET; writes accept `application/json` only (a JSON body cross-origin needs a CORS preflight, never answered); no state change on GET. Same-site is not enough: admin (`:8443`) and user app are the same site. |
| XSS | Vue escapes; no `v-html` except `Icon.vue` (constants; enforced by `test/spa-sources.test.ts`). Untrusted texts: external `global.ini` files, Discord names. Strict CSP from the app. |
| Clickjacking | `frame-ancestors 'none'`, `X-Frame-Options: DENY`. |
| Access control / IDOR | `Actor` only from the session + roster; a `guildId` from the request only with an active member row there; reads through functions that take the `Actor`, never "load by ID"; writes through the stock service only. DB tests cover other users' stock, other orgs, inactive members. |
| Missing auth | Auth middleware on everything except `/auth/*` and static files; a test asserts 401 for every route without a session. |
| Injection | Parameterized `sql` templates, Zod for every body/query/param, 16 KB body limit, amounts via `parseAmount`. |
| Session theft | HttpOnly, Secure, HSTS (Caddy), hashed tokens, no Discord tokens stored, `Referrer-Policy: no-referrer`, `no-store` on API responses. |
| Abuse | Rate limits in memory (one process): `/auth/*` per IP, `/api/*` per session. |
| DB privileges | Own role `qm_web` (see `docs/deploy.md` "DB roles"): no writes to `app.org`/`app.member` (role IDs, roster), no access to schema `bot`. |
| Leaks | Generic errors, stack traces in the log only; logs never hold cookies, codes or tokens. |
| Secrets, CORS | `DISCORD_CLIENT_SECRET` only in the `webapp` container; no CORS middleware (same origin only). |
| Dependencies, container | `pnpm audit --prod` before a deploy; containers read-only, `cap_drop: ALL`, `no-new-privileges`. |

No dev-mode login bypass; a dev-only "log in as" would need an env flag **and** refuse to start on a
non-loopback host.

Low review findings (2026-10-09, not built, decide later): the order of `batchNotFound` vs `notAllowed`
shows whether a batch ID exists; `holderName` in `lookup.ts` can show a nick from another org;
merge/move/refineDone can make an unshared part visible without a `share` history row; the history shows
old `share` rows of an org to new members; the logs channel is not checked to belong to the guild; the
WebSocket handshake has no IP rate limit and a limit race; the companion token has no scope or expiry; no
batch cap per user; an overflow in `refineStart` gives a 500; possible deadlock for opposite moves;
`db-roles.sh` passes passwords as psql arguments; `deploy.sh` writes the dump under its final name; compose
has one shared network and no resource limits.

## Parked: the web app as a Discord Activity

Parked 2026-10-10 (deep links and the board instead; revisit only for a collaborative feature or if users ask).
What it would need: its own host, token auth instead of cookies (the SPA runs in an iframe on
`<client-id>.discordsays.com`, requests through Discord's proxy, CSP allows only the proxy), an exception to
`frame-ancestors`/`X-Frame-Options`, a second allowed origin and a token handshake for writes and the
WebSocket, rate limits per token (all users may share few proxy IPs), and `register.ts` keeping the Entry
Point command once Activities are enabled. Launch from the App Launcher or as `LAUNCH_ACTIVITY` (type 12) to a
command, button or modal submit; auth via the Embedded App SDK `authorize()` → code → our backend →
`authenticate()`.
