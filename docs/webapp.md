# User web app

The users' alternative to the bot: personal stock, components, refinery jobs, blueprints, org stock, the
crafting check, history; login with Discord. Requirements and display rules: `docs/requirements.md`
"Web apps". Users without any org are first-class: every feature gets their path in the same step.

Status: built (backend, SPA, realtime, the features below, compose service), not live for users yet. Open
before go-live: the privacy notice (needs the controller's name and contact from the user: never invent
it), an OWASP ZAP baseline scan, the deploy (`docs/deploy.md`).

Commands (`pnpm webapp`, `webapp:dev`, …): `CLAUDE.md`. Locally the backend runs on `:3002`, its Vite on
`:5174` with a proxy for `/api`, `/auth` and `/thumbs`; always open it as `localhost`, never
`127.0.0.1` (another cookie host). The dev Discord application has the redirect
`http://localhost:5174/auth/callback`; the dev bot must run against the dev DB, else the roster is empty.

## Backend (`src/webapp/`)

- Hono, own process (`main.ts`); `createApp(db, identity, config)` in `app.ts` builds the app without a server, the
  tests drive it via `app.request`. `app.ts` and `realtime.ts` hold no login, session or token code: who the user
  is comes from the `Identity` passed in (see "Identity"); `main.ts` is the online composition root (Discord
  identity, `capabilities` `{ login: 'discord', orgs: true, uex: true }`).
- Middleware order: `secureHeaders` (strict CSP, no HSTS: Caddy sets it), the write check for every
  non-GET (the identity's `acceptsWrite`; online: `Sec-Fetch-Site`, else `Origin` = `WEBAPP_ORIGIN`; Hono's `csrf()` only covers form content
  types), `no-store` on `/auth/*` and `/api/*` unless the route sets its own (only `/api/catalog` and `/api/companion/catalog`: `private,
  no-cache` with an ETag from Hono's `etag()`, a hash of the body; unchanged = 304, ~3 MB per language
  spared (Caddy compresses nothing; the app gzips only `/api/companion/catalog`, below); the header is set outside `etag()`, whose 304 drops the route's headers), `hono-rate-limiter` (in memory: `/auth/*` per IP, `/api/*`
  per session), the identity's own routes (online `/auth/*`), `GET /api/capabilities`, then for `/api/*` the
  companion API check (only for a request the identity calls the companion's, see "Companion API"), the
  user check (the identity's `authenticate`; online 401 for every route, unknown ones too), JSON-only
  writes (415, `DELETE` included) and a 16 KB body limit (a feature's image upload: its own, see
  "Features and privileges").
- **How the SPA uses the capabilities.** A view never asks for the variant or the login. It asks either a capability
  (`capabilities.ts`: `orgsOn`, `uexOn`) or a trait derived from them in one place (`navigation.ts` `traitsOf`, exported by
  `capabilities.ts`): `localApp` (own settings, data updates, app version, start tile: `/api/local/*`), `singleUser` (no "who"
  and no "source", e.g. in the history) and `sideLayout` (header across the full width with the side bar below, instead of the
  top bar). Today all three follow from `login: 'none'`; they are named apart so a view says what it means and a variant that
  differs in one of them changes `traitsOf` only. Whether the page runs in the desktop shell (`shell.available`) or is the
  settings window (`windows.ts`) is a different question (the frame, not the variant).
- `GET /api/capabilities` → `Capabilities` `{ login: 'discord' | 'none', orgs, uex, game }` (`api-types.ts`): what this
  server offers (`ServerCapabilities`: `WebappConfig.capabilities` of the composition root, **a value or a function** returning it,
  asked at every request: the singleuser variant's `uex` follows the user's key; online passes a value; `orgs` is read once, when
  the app is built, because it decides which routes are mounted, so it cannot change at runtime) and the installed game data:
  `game` = `{ label, build }` of the latest catalog import (`label` like `4.10.2.12913470`, may be null for an old import), `null`
  while no catalog is installed. It lives here because both variants' top bars need it once at load, the route is public and
  already asked first, and it costs no extra request; the query (`game-version.ts`) is cached for 5 seconds and shared by concurrent
  requests, so a data pack install shows without a restart and the public route is no query per request. A failing query answers
  the last value (or null). The one API route answered without
  a user (the SPA and the companion ask before they have one); it sits before the user check, behind the
  per-address rate limit, `no-store`. Only this exact path and `GET`. `orgs: false` also leaves the org routes
  (`/api/orgs/…`) unmounted (`registerRoutes`' option; the API's 404). Every other route that takes a guild id
  checks the caller's membership there, so without memberships no parameter reaches an org.
- `WebappConfig.allowedHosts` (optional): the `Host` header values a request may carry; the first middleware answers any
  other with 421 `{ error: 'host not allowed' }`, and sends a GET/HEAD page request on a listed host that is not the
  origin's to the origin (307). Unset (online) = no check, Caddy matches the host. The WebSocket handshake takes the
  same list through `RealtimeOptions.allowedHosts` (421). Used by the singleuser variant (`docs/singleuser.md`
  "Host guard").
- `WebappConfig.mountApi` (optional): `(api: ApiApp) => void`, called with the API router after the regular routes and the
  identity's API routes and before the 404 catch-all, so the routes stay behind the identity check, the JSON-only rule for
  writes and the body limit. Online passes none; the singleuser variant mounts its data update routes
  (`src/singleuser/data-routes.ts`, `docs/singleuser.md` "Updating the data").
- Client IP: socket address, or the last `X-Forwarded-For` entry with `WEBAPP_TRUST_PROXY=1` (Caddy drops
  the client's own header).

### Identity (`identity.ts`, `identity-discord.ts`, `identity-local.ts`)

The seam between the HTTP layer and the variant it runs as. `Identity`:

| Method | Asked | Online (`discordIdentity(db, login)`) |
|---|---|---|
| `acceptsWrite(c, origin)` | every non-GET, before anything else; false = 403 | `Authorization` present (the companion's token: no cookie, and a page cannot set the header without a preflight) or same-origin |
| `mountRoutes(app, host)` | once, after the global middlewares | `/auth/login`, `/auth/callback`, `/auth/logout` |
| `isCompanionRequest(c)` | every `/api/*` request but the capabilities, before `authenticate` | `Authorization` present (any value) |
| `authenticate(c, host)` | every `/api/*` request but the capabilities, after the companion API check | `Authorization`: its token (401), never the cookie; else the session cookie (401, an unknown cookie deleted). Sets `session`, and `apiToken` for a token |
| `mountApiRoutes(api, host)` | once, inside the API | `GET`/`POST /api/token`, session only |
| `authenticateUpgrade(req)` | a WebSocket handshake, after path, Origin and the address limit | the session cookie; `valid()` re-validates it at every keepalive |

`host` (`IdentityHost`) is what only the app has: its origin and the client address of a request (for the log).
Online-only, all inside `identity-discord.ts`: the login, sessions and the API token. The local identity (one fixed user, no login) is described in `docs/singleuser.md`
"Identity".

### Login (`discord.ts`, routes in `identity-discord.ts`)

`openid-client` with hand-configured Discord endpoints (Discord is no OIDC provider; `arctic` was planned
but is deprecated on npm), code + PKCE S256 + state, scope `identify`, redirect URI = `WEBAPP_ORIGIN` +
`/auth/callback` (never from the request). State and verifier sit in the `__Host-qm_oauth` cookie (10 min,
SameSite=Lax: Strict would not be sent on the return from discord.com); the Discord access token is used
once for `/users/@me` and dropped (no refresh token kept). Failures redirect to `/?login=failed|denied`.

Deep links: `/auth/login?returnTo=<path>` keeps the page the login started from (in the OAuth cookie; paths
of this app only, never `//host` or a backslash: no open redirect) and the callback returns there; the
SPA's login button sends the current path and query. The bot links `/resources?scope=<personal|all|guildId>`,
`/blueprints?scope=<personal|guildId>`, `/crafting?add=<uuid>` (`webAppPath` in `src/bot/ui.ts`); each view
reads its parameter once in setup (`takeQuery` in `webapp/src/deepLink.ts`, views only render after the
login) and drops the query from the URL; an org the user is not in falls back to personal.

### Sessions (`session.ts`, `web.session`)

32 random bytes in `__Host-qm_session` (HttpOnly, Secure, SameSite=Lax), only the SHA-256 stored (a dump
yields no usable session); 14 days idle, 30 days absolute; a login replaces this browser's session;
validation re-creates a missing `app_user` row (sessions have no FK to it: the roster cleanup deletes
`app_user` once it holds no data); expired rows deleted hourly. The Discord profile (name, avatar) lives in
the session only, refreshed by each login; `/api/me` returns it for every user, also without any org
(default avatar from the ID). `MeResponse.name`, `username` and `avatarUrl` are nullable: `null` for a user without a Discord profile
(`Session.noProfile`, the singleuser variant's local user); a Discord user's answer is unchanged. Rights are never cached: `me.ts` reads the roster per request (active member
rows; a server the bot left has none: `markGuildLeft`/`reconcilePresence` deactivate its members).

### Features (`routes.ts`; the contract with all paths and shapes in `api-types.ts`)

- `GET /api/catalog?lang`: bookable materials with unit, the `component` flag, `label`, size, grade letter
  and class, a component's `stats` with bounds, loc `nameKey` and `base`; locations with refinery flag
  and the star map `key` (as Game.log names it, for the companion); materials `minable` (the
  mining data answers for it: a mined resource, a refined one from its ores, or a gem item); blueprints (`unlockable`: a
  row in `catalog.blueprint_source`; magazines included); each material and location with its loc `nameKey` (the companion looks it up in
  the player's language pack). From the shared in-memory catalogs; no ores, no refining methods.
- `GET /api/companion/catalog?lang` (2026-11-01): the companion app's catalog, the same rows (same order) with
  only the fields it reads (`CompanionCatalogResponse`, `Pick`s of the types above): materials without unit
  (follows from `kind`), class and `minable`; locations without yields; blueprints with uuid, label, name,
  size, grade letter, `isDefault`, `retired`, `outputUuid`, `thumb`. Cached like `/api/catalog` (`private,
  no-cache`, ETag). Session or API token like every route.
  Size per language (dev DB, 2026-11-01): ~2.45 MB instead of ~2.95 MB raw, gzip ~340 instead of ~360 KB
  (the components with their stats are most of it and the companion needs them). Gzipped by the server when the
  client sends `Accept-Encoding: gzip` (so the proxy needs no `encode`): `Content-Encoding: gzip`,
  `Vary: Accept-Encoding`, the gzipped body kept per language until the catalog's text changes; the ETag is
  the gzipped body's (taken after the compression), so a 304 compresses nothing anew.
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
- Trading (`trade.ts`, UEX prices from `src/ext/trade.ts`, see `docs/ext.md`): `GET /api/trade/prices` (the
  `PriceSummary` of every bookable material with a price: sell/buy min, max, UEX average, terminals, latest
  date), `GET /api/trade/items?lang=` (the item finder: every non-retired catalog material, resource or item incl.
  shop items, with an offer: name, type label (FPS gear with its sub type), size, grade, `bookable`, lowest buy and
  highest sell price; cached per language until the trade snapshot or catalog changes),
  `GET /api/trade/:uuid` (every terminal per side, best first; 404 without a price). `MaterialInfo.prices`
  and `value` in the summary (personal and per org: the same stored batches as the other figures, at the best
  sell price, whole aUEC, Ressourcen and Ausrüstung apart; unpriced batches left out; null without UEX data).
- `GET /api/summary` (overview tiles), `GET /api/info/blueprint|material/:uuid` (info cards),
  `GET /api/unlocks/:uuid` (a blueprint's unlocks, `unlocks.ts`, SQL in `unlock-query.ts`: sources of
  `catalog.blueprint_source` with their texts; missions grouped by faction · mission type, equal rows merged
  with a count, event tiers; odds = weight of the pool's total, reduced, plus `chance` below 1; the system of
  a locality or bound place is the star above it, roots without one (solar system records, the Nyx asteroid
  field) by the star key their key starts with; bound places that are no system are listed after it),
  `GET /api/mining` (every mined resource with what it refines into, its gem item and methods) and
  `GET /api/mining/:uuid` (where a mined resource, the ores of a refined one or a gem item is mined;
  `mining.ts`, SQL in `mining-query.ts`: one row per place, method and ore with the ore's `parts` in the rock
  (the rich part first, then the lean ones with `qualityScale` below 1; each with share, content and quality),
  largest share first; a moon shows
  its planet; asteroid mining bases and QV extraction stations, the same layout in many places, are one row per
  system with their count; see `docs/catalog-sources.md` "Mining"),
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
replaces the old; the dialog also links to the companion's GitHub releases). `Authorization: Bearer qmt_…` authenticates `/api/*` as the user (never falls back to the
cookie) and skips the same-origin check (a cross-site page cannot set the header without a preflight);
`/api/token` itself is session-only. Requests made with it are history source `companion`.

### Features and privileges (`features.ts`, `app.feature`, `app.privilege`, `app.user_privilege`, `app.feature_entry`)

Features beyond the roles for single users, e.g. supporter tools. A **feature** (key `^[a-z][a-z0-9-]{1,40}$`, a
description) has one or more **privileges**, each one right within it (key `<feature>.<right>`, e.g.
`thumb-review.mark`). Both come with the feature's migrations, are never deleted but retired. The admin assigns
privileges to users until taken back (`docs/adminapp.md` "Features"). In force = assigned, neither the privilege
nor its feature retired; read on every request (`privilegesOf`), `/api/me` lists the privilege keys
(`privileges`, the companion gets the same through its token).

A feature keeps its data in `app.feature_entry`: one row per feature, user and subject (e.g. a thumbnail's UUID)
with a JSON payload and optionally one image (`bytea` + MIME type; rows stay when privileges are taken back). The
DB grants `qm_web` writes on every feature's rows: the rights live in `features.ts` only. `FEATURES` there
defines per feature the subject's format, the payload's Zod schema, the image types and which privilege reads
(`read`) and which writes (`write`); a feature without an entry there is 404. Generic endpoints (`:key` = the
feature), each checking the privilege it needs (403 `noPrivilege`):

- `GET /api/features/:key/entries` (read): every row, newest first, with the author's name (newest web session,
  the token's profile, the roster) and `own`. Everyone who reads sees everyone's rows.
- `PUT /api/features/:key/entries/:subject` `{ payload }` (write): creates or replaces the own row (the image
  stays); `DELETE` (body `{}`: writes take JSON only) removes it. Only ever the own row: one row per reviewer,
  nobody overwrites another's.
- `PUT …/entries/:subject/blob` `{ type, data }` (write; base64 in JSON; the only route with a larger body limit,
  `BLOB_BODY_LIMIT`, 512 KB per image): the own row's image, checked against its type's signature (PNG, WebP).
  `GET /api/features/:key/blob/:id` (read): any row's image.
- Realtime: triggers send `privilege` (the user reloads `/api/me`) and `feature` with the feature as `g`; the hub
  sends `{type:'feature', key}` to whoever holds the feature's reading privilege.

Features so far: **`thumb-review`** "Thumbnail-Prüfung", one privilege `thumb-review.mark` (reads and writes;
subject = catalog UUID, payload `{ hash }` = the thumbnail it was marked on, a WebP reference image):
`GET /api/features/thumb-review/subjects?lang` lists every thumbnail of the index with name, class name, type and
item class label. The SPA view: "Views".

### Companion API (`companion.ts`, `locale.ts`)

The companion app itself is described in `docs/companion.md`; this is the server side. The server hosts no companion
files: the releases are the GitHub releases of this repository (https://github.com/w00zla/quartermaster/releases),
which the Companion dialog links to.

**Contract number.** The API contract is numbered, not the apps: `COMPANION_API` (in `api-types.ts`) is the number a
companion built from this tree sends and, for a server, its maximum; `COMPANION_API_MIN` is the oldest number the server
still accepts (`COMPANION_API_MIN <= COMPANION_API`, both 1 at the start). Both go into `GET /api/capabilities` as
`companionApi: { min, max }`, in both variants. A companion sends its number in `X-QM-Companion-Api` (an integer) and
its app version in `X-QM-Companion` (`x.y.z`, for logs and labels only, never decided on).

**The check** (`companionApiRefusal`, one implementation, run by the app for every companion request before the
identity's user check, so before the token check online): a number that is missing, not an integer or below
`COMPANION_API_MIN` = 426 `{ "error": "companionOutdated", "apiMin": <n> }`; above `COMPANION_API` = 409
`{ "error": "serverOutdated", "apiMax": <n> }`. Neither carries data or links. Every `/api/*` route is covered
(writes and unknown routes too) except `GET /api/capabilities`, which is how a companion finds the range. What a
companion request is, is the identity's call (`isCompanionRequest`): online a request carrying `Authorization`
(whatever its value; the web app sends a cookie); singleuser a request carrying `X-QM-Companion` or `X-QM-Companion-Api`
(no tokens there; the header is a label, any local program may send it or leave it out). The web app's own
requests are never checked.

**Locale** (`GET /api/companion/locale`): the game's own English texts, so the companion needs no hand-placed
`global.ini`: the `game` source in `en` of the installed catalog, never the effective texts (the singleuser variant's
language pack and external sources sit above the game's texts there and must not leak into this table; the companion
reads the player's pack itself). The same lines a `global.ini` has: `key=value`, UTF-8 without BOM, `\n` line ends, a line
break inside a value written back as the two characters `\n` as the game does, keys as stored (lower case, without
`,P`), ordered by key. `Content-Type: text/plain; charset=utf-8`. The ETag is the game source's `content_sha256`
(`"<sha>"`, `"<sha>-gzip"` for the gzipped body), so it changes exactly when a catalog import changed the game texts and
costs no hash over the ~90k rows; a matching `If-None-Match` = 304. `Cache-Control: private, no-cache`, gzipped when the
client accepts it (`Vary: Accept-Encoding`). The text (and its gzip) is kept in memory until the source's hash changes.
No catalog installed = 404 `{ "error": "noCatalog" }`. Authenticated and version-checked like every companion route.

### Thumbnails (`thumbs.ts`, `src/thumbs.ts`)

Item icons are rendered by packshot from the game models (`docs/catalog-sources.md` "Icons"; the targets: `src/catalog/thumb-targets.ts`);
`pnpm thumbs:build [--in <packshot main set>] [--out <dir>] [--force]` (`tools/thumbs`, Rust with ravif) packs them: 8-bit AVIF,
quality 45, trimmed to the content, resized premultiplied, unchanged ones skipped, stale files deleted. A full set (~6700) takes
~80 s and ~38 MB. `THUMBS_DIR` (default `local/thumbs`) holds the result: `s/`, `m/`, `l/` (40, 96, 256 px AVIF, shown at 20, 48, 128 CSS px) with
`<uuid>.<hash>.avif` each and `thumbs.json` `{uuid: hash}` (re-read when it changes; a broken one keeps the
previous). The hash is the first 8 hex of the source PNG's SHA-256: a URL never changes its content.
`GET /thumbs/<s|m|l>/<uuid>.<hash>.avif` serves only what the manifest names, without login (game renders,
fan content like the wiki's), `Cache-Control: public, max-age=31536000, immutable`: every image crosses
the line once per device. The catalog carries the hash (`CatalogMaterial.thumb`; `CatalogBlueprint.outputUuid`
and `thumb` for the crafted item): no hash = no request (the type icon stays), so no 404s. Mining rows carry
the ore's (`MiningRow.oreUuid`, `thumb`: ores are no catalog materials), history entries their `targetUuid`
(the SPA looks it up in the catalog). Clients build the
path with `thumbPath(size, uuid, hash)` from `src/thumbs.ts` (API consumers prefix their server). Same
origin: the CSP is unchanged; Vite proxies `/thumbs` in dev. In production Caddy serves `/thumbs/*` straight from
the same directory (`docs/Caddyfile.example`, without the manifest check); the route is what dev and a setup
without that block use. Upload to the VM: `docs/deploy.md` § 8. Where the SPA shows them: "Layout and building
blocks".

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
  / 20 per address, the user (the identity's `authenticateUpgrade`: the session cookie); keepalive every 25 s
  pings and re-validates the session (`SocketUser.valid`; close code 4401 when gone). Client messages: JSON `{type:'ping'}` only (Zod), 4 KB, 20 per 10 s, anything else closes
  (1008). Writes stay on REST. CSP `connect-src` lists the ws(s) origin explicitly.

## SPA (`webapp/`)

- Vue 3 + Vite like `adminapp/`, imports the admin's styles and components relatively from `adminapp/src/`
  (no copies; `Icon.vue` is the only `v-html`, constants only, `test/spa-sources.test.ts` enforces it).
  `Picker.vue` has no i18n of its own: its two texts come via `provide(PICKER_LABELS)` in `App.vue`. Shared pure code from `src/` is listed in
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
  locations), Harvestables/Sammelobjekte (until 2026-10-20 "Items"; pieces; kinds · locations), Gear/Ausrüstung (the same), Blueprints "X / Y" (Y = obtainable:
  not retired, not default, in a reward pool of the game data (`blueprint.in_reward_pool`), cached per import; X = every registered one
  and may exceed Y: then the game data misses a source, listed in the admin overview), Refinery jobs (sum of
  the expected yields · stations) and Next job ready (countdown, a "n ready" tag); "Your orgs" with one
  sub-tile per org (name, state, "Members: n", Resources/Items/Blueprints). Reloads on every realtime message.
  The last tile of both is "Gesamtwert" (at the best UEX sell price, rounded up and compact: "21 Mio." /
  "21M", Intl `notation: "compact"`; detail line just "aUEC").
- **Ressourcen** (route `/resources`, until 2026-10-20 "Bestand" at `/stock`; materials only, no ship
  components): grouped by material, filters; scope "All" lists personal
  and org stock with an owner column ("Pers." / "Org (holder)"). Adding has a share switch per org (an org
  scope starts with that org on; the batch is always personal, the switches share it). Row actions Sharing (a
  switch per org, whole batch) · Split (unshared) or Merge back (a split-off part) · Move (place, recipient) ·
  Remove · Adjust; on batches you cannot change (org scope, "All") the same buttons, disabled. UEC columns (titled "UEC Verkauf" etc.: the heads are upper case, "aUEC" would read "AUEC"; the table's face, dimmed, no unit after the values: it is in the title; amount × UEX price, BigInt micro units; batch rows their value, the group row
  the material's total; "—" without a price): "UEC Verkauf" (best sell) shown, "UEC Kauf" (best buy) and both
  averages hidden by default; Ausrüstung has "UEC Verkauf" and "UEC Kauf" only (items have no averages).
  The panel title adds the list's worth at the best sell prices, set apart (mono, 12 px, dimmer): "Ressourcen · Persönlich (123.000
  aUEC)" (its stored batches with a price, like the overview's total; every scope, "(0 aUEC)" without any price).
  Ressourcen and Ausrüstung: a last fixed column with the "Handel" button
  (`ChipButton`) on each material's row, disabled without a UEX price; it opens `TradeDialog.vue`: tabs
  "Verkaufen · n" / "Kaufen · n" (only sides with prices), each a `DataTable` of every terminal grouped by system (`groupOf`: a head row per system, by name, the rows' first cell indented; Terminal as
  "place – shop", e.g. "ARC-L1 Wide Forest Station – Admin", its tooltip adds the report's date "· Stand …"; Preis (with a quiet "aUEC" after it),
  Nachfrage / Bestand as a bar against the side's largest amount with a tick at the terminal's average, the figures
  on hover; items without that column; no System or Stand column since 2026-11-01), Kaufen by terminal name,
  Verkaufen best price first, a system filter ("Alle Systeme", right of the tabs; a system the next pick lacks
  goes back to all), widths `qm.webapp.columns.trade-dialog-{buy,sell}`, scrolling inside (the tabs and tables: `TradeTables.vue`, shared with Handel); UEX's averages in the head.
- **Ausrüstung** (route `/gear`, until 2026-10-20 "Komponenten" at `/components`; `?scope=` like Ressourcen;
  `ComponentsView` = `StockView` with `components`; icon `gear`, a case with a handle): the ship components and
  FPS gear (since 2026-10-22; their type reads "Helmets · Light", "Attachment · Barrel": `itemTypes` in
  `routes.ts` adds the sub type; the type column with its icon, `TypeLabel`; no size but on attachments), groups named by their `label`, no quality column, filters
  type/size/grade instead of the quality slider; the add form without quality (sends 0) but one slider per
  stat of the picked component from ±0 to its best (`CatalogMaterial.stats`, reset after each add; a drop
  like recoil runs the same way, ±0 at the left, its values negative; only changes are sent); a Stats column ("Coolant Rating +5.0 % · Integrity +2.0 %", `statsText` in `format.ts`; without
  any gain a dimmed "Standard"/"Default"; the
  sliders are `StatSliders.vue`, also in the batch dialog's Adjust, which confirms "from → to"); "Anzahl" in
  pieces instead of "Menge" (each row "1 Stk."); `BatchDialog` leaves the quality out (`withQuality`/`qualityPrefix`).
  Its Adjust button (the stats) is disabled for a component without stats, not left out. A Class column
  (`itemClass`, "Military", …) is hidden until switched on.
- Ressourcen, Ausrüstung and Blueprints: every column but the name and the actions may be hidden (`hideable`);
  the small eye button right of the filter chips (`ColumnsButton.vue` → `ColumnsDialog.vue`, texts via
  `columnsTexts()`) switches them, kept with the widths in localStorage
  (`qm.webapp.columns.{stock,components,stock-org,components-org,bp-mine,bp-org}`; `hiddenByDefault` columns start hidden, the ones the
  user switched on are kept as `shown`). The org scopes of Ressourcen/Ausrüstung keep their own columns: a
  Halter column, no Status column (refinery jobs are never shared, the share tag is not needed there), every
  UEC column hidden by default. The owners of an org's blueprint list may be hidden too. Columns naming people
  (Halter, Besitzer, History's Von) use the UEC columns' face (`.user-cell`: mono, 12 px). `DataTable`
  renders only the shown columns, passes `#col-<key>` head slots on (with the table as `table`) and exposes
  the column state as `table` (the blueprint list's chooser outside the table). The action and Handel
  columns are exactly as wide as their buttons (the Handel button fills its column). The blueprint list's
  Stats column is dimmed and smaller.
- **Raffinerie**: running jobs as a table with one group per work order (station, total yield and the time
  left with a "ready" tag or "duration open" on the group row; actions: a clock opens `RefineryTimeDialog` to
  set or clear the time left, done, remove with a `ConfirmDialog` listing the materials), the materials below
  with quality and expected yield; job columns sort the jobs, material columns the materials
  within; same filters as Ressourcen. `RefineryStartForm`: station, duration (all three fields empty = "duration
  open") and rows of resource, quality and expected yield (no method, no estimates). `RefineryDoneDialog`
  stores the whole job, each row's amount starting from its expected yield.
- **Blueprints**: no "All", the admin's `DataTable` with category/type/size/member filters, names bold with the crafted item's thumbnail before them (the type column the type's icon and name, `TypeLabel`); an org
  shows every blueprint its active members registered with who has it (the remove button there disabled). A click on a row puts it into the
  crafting check (`addToCrafting`) and opens the tab. The last column (fixed, both scopes) holds the
  "Freischaltung" button (`ChipButton`, disabled without an unlock; its click never reaches the row): it opens
  `UnlocksDialog.vue`, one section per kind; missions in collapsible groups (collapsed, a single group open;
  head: count, systems, rank span, best chance), every row listed (title with the game's placeholders as "…",
  rank, systems · bound place, markers Kette/Illegal/Annahme/event, chance), the list scrolls inside with a
  sticky head row; event tiers with event, points and chance. Wording in `webapp/src/unlocks.ts`.
- **Crafting** (the third tab bar, the tools, with Bergbau and Kaufen/Verkaufen; the overview has a bar of its own, the data views the second): `CraftingView`, `CraftingPicker`, `PlanEntryCard`, plan in
  localStorage `qm.webapp.crafting`; the planner's warnings are codes with values (`PlanWarning`), worded by
  `warningText` in `webapp/src/crafting.ts`. Each card has a count (1–99) and per slot a quality slider and
  field that stop at the slot's minimum (`withQualityFloor`; the track keeps the full 0–1000 scale). Below the
  stats a collapsible "Resources" panel (closed by default; opened ones in localStorage `qm.webapp.crafting.ui`):
  per material the need (for the card's count) and a chip "covered" / "missing <amount>", then the stored
  batches of that material at or above the card's target quality, own first, then by quality. The stock is
  `GET /api/stock?scope=all`, loaded once per view and on stock/resync messages; each card is checked on its
  own. Pure logic in `src/planner/stock.ts` (shared with `/qm-crafting`), tested in
  `test/crafting-stock.test.ts`. Below it a collapsible "Besitzer" ("Owners") panel built the same way (closed
  by default, opened ones as `ownersOpen` in the same localStorage entry): "Du" with "vorhanden" / "fehlt"
  ("Standard" for a default blueprint, then nothing more), then each of your orgs with its active members who
  registered it ("niemand" without) and their count; from `GET /api/blueprints` and
  `GET /api/orgs/:g/blueprints` per org, loaded once per view and on blueprints/members/profile/resync
  messages. The card's head is the crafted item's info tile (see "Info tiles"); its title row's right holds
  the "Freischaltung" button (as in the Blueprints list), the count and remove. Each material line of the Resources panel ends with a pickaxe icon button (grey without
  mining data) that opens `MiningDialog.vue` with the `MiningTable` (see Bergbau) against the material's target
  quality (the need's `quality`): a green chip "Ziel-Qualität 600" first in the toolbar (changeable, 500–1000 in
  steps of 50, not written back to the card), the card dims the values below it, shows those reaching it in green and
  adds per system "≥ 600" (the chance a part reaches it, "nie" when never).
- **Bergbau** ("Mining", route `/mining`, the tab right of Crafting): `MiningView`, one section per mining
  feature; the first, "Fundorte" ("Where to mine", locate icon), holds a picker (416 px, like Kaufen/Verkaufen's; Crafting's search 390 px) over the mined resources (ores,
  raw materials, gems; what an ore refines into searched too) and the `MiningTable` (layout A of the concept
  https://claude.ai/artifact/ERWoBH6j1SZi5oD5g5zj1x, the same in the dialog): a system and a
  method filter (`Dropdown` chips like the stock's, "Alle Systeme"/"Alle Methoden"; shared with the dialog for the
  session; in the view right of the picker, `filtersOutside`, in the dialog in the table's toolbar), then `MiningQualityCard` with the quality once: per part of the ore (rich part, "Rest ×0,49") its
  content range and one bar per set of systems with the same values ("Stanton · Nyx", "Pyro": the game's values
  differ only by system), a thin bar (segments by chance) with every value of half a percent and more below it in plain text (wrapping where narrow),
  colored by level (grey below 500, the accent from dim to full, gold at 1000; no level marks: too wide), then
  the shared `DataTable` (resizable, sortable, widths per browser: `qm.webapp.columns.mining`, `…mining-ores` with
  the ore column), grouped by system (a head row per system), one row per place, method and ore: place (a moon
  with its planet, grouped places with their count), method (Schiff/ROC/Hand), the ore when the rows come from several, share of the method's rocks
  there ("Häufigkeit", with a bar in the color of the rock's rarity class, the class in its tooltip, and a help tooltip in the head; not "Anteil": next to "Gehalt" both would read as a share; rarity has no column of its own: two columns read alike), the parts' content ("Gehalt (gut · Rest)", the lean ones dimmed, a help tooltip); no
  quality column (the system says which bar applies). Wording, the card's grouping and filters in
  `webapp/src/mining.ts`.
- **Kaufen/Verkaufen** ("Buy/Sell", tab and title since 2026-11-01, before "Handel"/"Trading"; route `/trade`, the tab right of Bergbau, icon `trade`;
  the stock rows' button and dialog keep "Handel"): `TradeView`, the item finder. A section "Preise"
  with a picker (416 px) over everything UEX has a price for (`GET /api/trade/items`, per visit and language: resources,
  gear and the catalog-only shop items; bookable components by their catalog `label`, the rest by name, the type
  as the hint; the pick kept for the session), UEX's averages dimmed at
  the bar's end, below it the pick's info tile (`InfoTile.vue`, see "Info tiles"; no prices: the tables have them) and the
  trading dialog's `TradeTables` for the pick (`GET /api/trade/:uuid`) with `split`: both sides as two columns
  (Kaufen left, Verkaufen right, one below the other under 1100 px; an empty side "Keine Terminals"; own column
  widths `qm.webapp.columns.trade-view-{buy,sell}`); the system filter right of the picker, kept for the session; tile and tables appear together once both are loaded. The
  trading dialog keeps its tabs. (A section "Nach Ort", what a place's shops trade, was built and taken out
  again on 2026-11-01.)
- **History** (route `/history`, `HistoryView.vue`): see `docs/stock.md` "History".
- **Thumbnail-Prüfung** (route `/feature/thumb-review`, as every feature `/feature/<key>`, `ThumbReviewView.vue`, privilege `thumb-review.mark`; without it the
  view says so and no button shows): every thumbnail (the L file at 132 CSS px) in a grid per item class and sub type,
  resources apart, sorted by name; above it a panel "Worum geht's?": one line that wrongly rendered thumbnails get marked to be fixed later, one
  on how it works, one on the yellow border; it folds by a click on its title row or the chevron at its top right, remembered per browser; search over name and class name, a chip "Nur markierte". A click on a thumbnail
  marks it as wrong (own row) or takes the mark back (with a reference: confirmed in a dialog). A marked tile has a
  camera button: "Screenshot-Quelle wählen" picks a screen, window or tab once (`getDisplayMedia`, the stream stays open, a
  tag shows its state), each capture takes its current frame into a dialog where the mouse draws the region (none =
  the whole frame); saved as WebP (scaled down until under 512 KB). Tiles: red border = marked by you, yellow =
  only by others, a count tag with several reviewers, their names in the tooltip, the reference inset (yours, else
  the newest), "Neu gerendert" when a mark was set on another hash than the current thumbnail. Others' marks arrive
  live (realtime `feature`).
- Info cards: hovering a blueprint name or a material shows game data from `GET /api/info/...`
  (`InfoTip.vue`: loaded on first hover, cached per language, teleported overlay; never the raw records; the
  card's content and its loader `loadInfo` are `InfoCard.vue`). No maker anywhere (card, tile; decided
  2026-11-01: it only takes room). The meta line after a bullet (the tile's facts line too). The game's text as
  one piece (`descriptionText`; not split into values and prose: it is all the game's text), in the quietest
  colour: head lines the card shows anyway (type, size, grade/"Güte", class, German and English) go where the
  card has that value, the maker's always; spaces at line ends and doubled ones go, at most one blank line in a
  row; cut after eight lines. The server keeps of a line the German pack states in both languages ("Typ (En): …" /
  "Typ (De): …", "Fokus") only the one in the asked language, without the tag (`descriptionInLang` in
  `src/catalog/labels.ts`). An item's card shows "Bauplan" for the blueprints that craft it
  (`MaterialInfo.craftedBy`): per blueprint Standard (its name only when it differs from the item's or there are
  several), then the unlock lines as on a blueprint's card; none: "Kein Bauplan". "Preise" always: a side without
  a price "—", none at all "Keine Preise". No craft time in the cards (the Crafting card has it).
- Info tiles (`InfoTile.vue`, layout "Kopfband" of https://claude.ai/artifact/7E3fP8B5PczRWeWbexVDAG, 2026-11-01):
  the same data as a header band, for Kaufen/Verkaufen's pick and as the head of each Crafting card (the crafted
  item, `outputUuid`): the M thumbnail at 96 px (72 px on phones), name with its tags (slot; Crafting:
  Standard/Ausgemustert), one line of plain facts (Crafting: the blueprint category first; item: type ·
  S1 · Grade C · class; resource: group, Raffiniert zu, Aus Erz, Verwendet in), a little apart the game's text
  (as in the card, three lines at most with an ellipsis; only when cut the whole text as a tooltip and the help
  cursor, like the names with an info card; measured again on width changes); no boxes and no prices (nothing in the band looks like an input). At the right
  the caller's `actions` at the top (Crafting: count, remove) and its `corner` at the bottom (Crafting:
  Freischaltung). While the card loads the band stands (thumbnail, name, the lines' height): nothing moves.
  A blueprint's card ends with "Freischaltung" (`BlueprintInfo.unlocks`): one line per kind ("126 Missionen",
  "1 Event-Stufe"; code per kind, more kinds can follow), marker tags only when every source of that kind has
  them (Illegal red, Event yellow; Kette, Rang, Zufall, Annahme grey), right the best chance ("bis 1 von 6",
  "1 von 14", "sicher"); no details; none: "Keine".
  A material's card ends with "Preise" ("UEX · 21.10.2026, 14:17", the latest report, to the minute like the dialog's Stand: `priceTime`) when UEX has a price: lines
  Verkauf/Kauf with the range and, dim, UEX's average (items: the number of terminals); no locations.
- Profile (RSI handle, language) is a dialog from the settings icon button next to the avatar (the avatar
  itself is not clickable), saved with Save; no language switch in the header.
- Top bar right: the privileges' features as outline buttons (route links; Thumbnail-Prüfung, icon `eye`, accent on
  its page; only for holders), Companion (`desktop` icon), divider, avatar with
  name, profile, logout (icon only). Footer (from BindSight, one line, sticky): credits, "Powered by:" with
  a logo link to UEX (`uex-logo-{20,40}.png`, Lanczos from its touch icon), a divider, a short CIG fan site disclaimer (the full text on hover) and the Star Citizen
  logo from the official fankit (`webapp/src/assets/sc-logo-{20,40}.png`), on every page incl. login.

### Capabilities and the singleuser UI

The SPA asks `GET /api/capabilities` before anything else (`capabilities.ts`, reactive; retried every 2 s while the server does not
answer) and only then loads `/api/me`. What it shows follows the capabilities, not a build flag:

- **`login: 'discord'`**: the online behaviour as always (login view, user, profile, logout, companion dialog, the
  "thumbnail review" privilege button).
- **`login: 'none'`** (the singleuser variant): no login view, no user name or avatar, no profile dialog, no logout, no companion download
  dialog, and no top bar: the navigation is the side bar ("The side bar and the settings window" below), whose "Settings" entry opens
  the settings window of the desktop shell or, in a plain browser, `/settings`; the route exists only without a login, with a login
  it leads home (`navigation.ts` `routeAllowed`, a router guard, and `App.vue` re-checks the current route when the capabilities
  arrive or change).
- **`orgs: false`**: no scope switch (`ScopeBar` renders nothing), no "Your orgs" panel on the overview, no sharing button in the stock
  table (its actions column is one button narrower). The rest of the org handling needs no condition: a user without any org already
  is a case (`me.orgs` is empty: no share switches in the add form, no recipient pickers, no owners lines).
- **`uex: false`**: no buy/sell tab (and `/trade` leads home), in the stock and gear tables no UEC columns, no trade button column
  and no worth in the head (no `/api/trade/prices` request), no trade dialog, no price section in the info cards, no worth tile on
  the overview. A UEX key set or removed in the settings changes the capabilities at once; the views follow.
- **The game version chip** (`.ver-chip`, mono; tooltip "Spielversion") in the top bar (online) and in the slim bar beside the side bar (singleuser) shows `capabilities.game.label`,
  a dash while there is none. It has the width of a game version, so the dash and the number take the same room and nothing moves.
  The capabilities are refreshed after a data install, after the UEX key changes and every 15 s while the data state is idle.

The navigation is built from `navigation.ts` (pure: which tab groups, which top bar controls, the side bar's groups and width, which
routes for which capabilities).

### The side bar and the settings window

**The side bar** (`SideNav.vue`, singleuser only; the online variant keeps `TopBar.vue` unchanged) runs from below the header (the slim bar) down
to the footer (the singleuser app is as high as the window and only the content beside the bar scrolls). From the top: the groups of `sideGroups` (the top bar's three, then History as a group of its own, drawn
quieter: 13 px, weight 400, dimmed) one below the other with a divider between groups; nothing below them. The toggle is a small
button at the middle of the bar's height, half over its right edge (chevron, tooltip). Two modes: *wide* (icon and text, 232 px) and *narrow* (icon buttons, 56 px, each with the companion's `Tooltip.vue`, which
opens above or below the button). The choice is stored in `localStorage` (`qm.sideMode`, in a try/catch); below 1000 px of window
width the bar is narrow whatever the choice (`sideModeFor`; the stored choice is not touched, the toggle is disabled then). The two
modes differ in width only: buttons are 36 px high either way, icons sit at the same place, the tooltip wrapper exists in both.

**The slim bar** (`SlimBar.vue`) is the header across the window's full width, above the side bar and the content, as the companion's top bar (56 px, the narrow side bar's width; never wraps): the app's logo (36 px) and wordmark at the left, the drag region, the game version chip
(`.ver-chip.fixed` with the quiet "Game:" label), the settings button (gear `icon-btn`, as the top bar had it: the shell's settings
window, in a plain browser the `/settings` page, accent on that route) and, in the shell, the window buttons. In a plain browser it is the same bar without
window buttons and drag attributes. It measures its height into `layout.ts` `topbarHeight`, so the toasts sit below it. The footer
(`AppFooter.vue`) stays across the full width.

**The settings** (`SettingsView.vue`) are built like the companion's settings window (`companion/src/SettingsApp.vue`): one tile 560 px wide that
grows downward, a head (settings icon, title, the app's version small in mono), a body with four groups (a tile on the base background,
a head row of its own (icon, title, state tag; `styles.css` `.settings-group`, shared with the companion), a field's label above its input, other rows label left and control right) and, in the settings
window only, a foot with "Close" (everything applies at once: no save button). On the page the tile has the panels' corners; in the
window it is the window's content, with no margin around it.
Each state tag sits in its group's title next to the name (a word, never colour alone); the title is positioned absolutely, so a tag appearing moves
nothing. The decisions are in `settingsLogic.ts`:

- *Star Citizen* (`/api/local/settings`): the path field applies on Enter or when it loses focus with a changed value. A refusal (422) shows
  "no game in this folder" and the "no game" tag and keeps the saved setting (the typed text stays). "Browse" exists only where the shell
  has a folder picker; it is the primary button while there is no usable folder, without a picker the field gets the accent border instead.
  The game version and the language pack's tag (active, none, restart needed) follow the settings.
- *Game data* (`/api/local/data`): installed version, time of the last check, the amount while something downloads (that row replaces the
  check time), "Import file" (a dialog with a path field, plus the picker button where the shell has one) and "Check for data"; both are
  disabled while something runs. The state is polled while its phase is not idle.
- *UEX* (`/api/local/uex`): the key field is a password field showing a mask while a key is set; "Save" stores a typed key, a cleared
  field removes the key after a confirmation. The interval select (15, 30, 60 minutes) saves at once and is disabled without a key. One
  row holds the times of the last and the next fetch (local; today as the clock, other days with the day); "Fetch now" (next to the link
  to UEX) needs a key and a pull that is not running; the state is polled every 1.5 s while pulling. A refused key shows the "Refused" tag
  and a message.
- *App*: the version (with the "App Update" button where the shell offers updates), the automatic updates switch (saves at once) and the
  language select (`me.langOverride` through `/api/profile`; the profile dialog that holds it online does not exist here). A value the
  environment overrides (`overridden`) is shown, disabled.

**The settings window.** In the desktop shell the settings are not a page but a window of their own: the side bar's Settings entry (and the
first run) calls `open_settings`; the shell opens a second window, label `settings`, with the same origin at
`/settings?window=settings` (or brings it to the front). The query is read once at start (`windows.ts` `settingsWindow`, pure part
`windowMode`): in that mode `App.vue` renders only `TitleBar.vue` (with the title and the close button alone: `WindowButtons`
`closeOnly`) and `SettingsView` (no side bar, footer, start tile, realtime or routes; the window works without game data, as the panel
needs no catalog). The window cannot be resized: once its panel and the fonts are rendered, the page measures its height and calls
`settings_window_fit` (`settingsFitSize`: 560 px wide, the height of the content plus 2 px, at least 400 px, which leaves the dialogs
the panel opens, `ImportDialog` and the remove-key `ConfirmDialog`, room); the shell sizes and shows it. The settings window waits for
the shell's update state before it renders (`main.ts`), so the height with or without the "App Update" row is known when it measures.
In a plain browser the entry is the `/settings` page inside the normal layout.

**The two windows** tell each other over one `BroadcastChannel` (`windows.ts`, name `quartermaster-windows`; safe where it is missing:
nothing is sent). The settings window posts `changed` after every successful change (`local.ts`: `saveSettings`, `pullUex`,
`checkData`, `importData`; the language in `SettingsView`); the main window answers with `reloadAll()` (settings, data state, UEX state,
capabilities, `me`, then the data polling at its quick pace once), so a saved UEX key shows the trade tab, the language and the game
version follow. "App Update" in the settings window posts `open-update` and calls `window_focus_main`; the main window opens the update
dialog (`shell.openUpdate()`) and is brought to the front: the dialog stays the main window's.

**The first run:** without a usable game folder (`firstRun`) the settings open by themselves (the shell's window, in a browser the page),
once per page load and only after the app is shown (not over the start tile); the user can leave them.

**The start tile** (`StartTile.vue`, state from `startTile.ts`) replaces the whole app (side bar, views, footer) while `login: 'none'` and no data
pack is installed: the logo (128 px), the wordmark, the app version, four segments and one line of text; a
download adds the amount ("12 / 45 MB") and a bar. Phases map to the steps: nothing known yet "Starting …" (1), checking and downloading
"Loading game data …" (2), installing "Setting up game data …" (3). Without a connection (outcome offline or failed with nothing
installed) the tile shows the "No connection" tag, "Game data missing." and two buttons, "Try again" first and then "Import file" (primary; the same dialog as in the settings;
"Try again" posts a check); everything on the tile is centred; the same layout with "Game data missing." alone where nothing will fetch the data (updates off, no
data channel), and with the "App update needed" tag where the newest data needs a newer app. The state (`local.ts`) is polled every
second while it is busy and rarely while idle, each request with a 3 s limit. **A request that fails or times out while a check, a
download or an installation was last seen counts as "still installing"** (the catalog import blocks the whole process for seconds, the
state endpoint included), never as an error; five failed requests in a row with nothing running say the server is not reachable.
When a data pack appears (`installedTag` changes) the catalog cache is dropped and the catalog loaded again, and the views mount
fresh: no reload by the user.

**The bold notice** (`UpdateNotice.vue`) sits above every view while the last data outcome is `appTooOld` with `pack: 'newer'` or a
`failed` with reason `unsupported`: "App update needed / New game data needs a newer app." Its button is rendered only where the
shell offers app updates.

**The shell adapter** (`shell.ts`, the contract and its pure part in `shellLogic.ts`): the one place where native functions enter the
SPA, a reactive object `shell` with `available` (the desktop shell is there: pickers and window chrome), `pickFolder()`,
`pickFile(extensions?)` (both answer null when cancelled or unavailable), `updateAvailable`, `update` (the updater's state),
`openUpdate()`/`closeUpdate()`/`updateOpen`, `checkUpdate()`, `installUpdate()`, `setChannel(id)`, the window (`maximized`,
`minimize()`, `toggleMaximize()`, `close()`, `startResize(direction)`), the settings window (`openSettings()`, `fitSettings(width, height)`,
`focusMain()`). `initShell()` (called in `main.ts` before the first render)
binds the global the shell injects; in a browser everything stays "not available". No shell package is imported by the SPA.

**Links that leave the app.** With the shell present, `initShell()` installs one `click` and `auxclick` handler on the document: a primary or
middle click (or Enter on a focused link) on an `<a target="_blank">` with an absolute `https://` href, wherever and whenever it is
rendered, is taken over (no in-app navigation, no second window) and sent to `open_external`; a failed call shows the error text as a
toast. The decision is the pure `externalLinkUrl` in `shellLogic.ts`. In a browser nothing is installed and the links work as links.
There is no `window.open` call in the SPA. Links with other hrefs (`blob:` previews) are left alone.

### The desktop shell (the contract)

The desktop app is its own Tauri program (`app/`; how it implements this contract, its capabilities and its updater: `docs/app.md`): it starts
the server as a sidecar ("The app bundle" in `docs/singleuser.md`), waits for `QM_READY`, and shows `http://127.0.0.1:<port>` in its window. The SPA talks to it through the global `window.__TAURI__`
(Tauri's `withGlobalTauri`): `__TAURI__.core.invoke(command, args)` and `__TAURI__.event.listen(event, handler)`. Without that global (or
without `core.invoke`) nothing below exists: pickers answer null, no window chrome, no footer button, no app update.

Commands (`args` is one object, possibly empty; a rejection carries a text):

| Command | Arguments | Result |
|---|---|---|
| `pick_folder` | `{}` | the chosen folder, or `null` when cancelled |
| `pick_file` | `{ extensions: string[] }` (without the dot, e.g. `["zip"]`; `[]` = any file) | the chosen file, or `null` |
| `open_external` | `{ url: string }` | nothing; opens the URL in the system's default browser. The shell accepts only an absolute `https://` URL with a host and no credentials, and rejects anything else (http, file, custom schemes, `javascript:`, `data:`, relative, with credentials) with a text |
| `window_minimize` | `{}` | nothing |
| `window_toggle_maximize` | `{}` | nothing (maximizes, or restores when maximized) |
| `window_close` | `{}` | nothing |
| `window_is_maximized` | `{}` | `boolean`; asked at start, after every toggle and at every `resize` of the page |
| `window_start_resize` | `{ direction: "North" \| "South" \| "East" \| "West" \| "NorthEast" \| "NorthWest" \| "SouthEast" \| "SouthWest" }` | nothing; the window starts a resize drag from that edge or corner |
| `open_settings` | `{}` | nothing; opens the settings window (label `settings`, the same origin at `/settings?window=settings`, frameless, not resizable, hidden until sized) or brings it to the front. Main window only |
| `settings_window_fit` | `{ width: number, height: number }` (CSS px) | nothing; sets the settings window's inner size (at most 95 % of its screen), centers and shows it. Settings window only, sent once after its first render |
| `window_focus_main` | `{}` | nothing; un-minimizes the main window and brings it to the front. Settings window only |
| `update_state` | `{}` | `UpdateState` (below) |
| `update_check` | `{}` | nothing; starts a check, the progress arrives as `update-changed` |
| `update_install` | `{}` | nothing; starts download and install of the available version |
| `update_set_channel` | `{ id: string }` | nothing; saves the channel and checks it at once |

```ts
interface UpdateState {
  state: 'idle' | 'checking' | 'current' | 'available' | 'downloading' | 'installing' | 'error';
  current: string;           // the running version, without "v"
  available: string | null;  // the version found, without "v"
  notes: string | null;      // plain text
  progress: number | null;   // 0..1 while downloading, null when unknown
  error: string | null;      // shown as it is, in the error colour
  channel: string;           // the selected channel's id
  channels: string[];        // every channel the user can select
}
```

Event `update-changed`, payload `UpdateState`: at every change, progress included. Dragging the window is not a command: the title bar
carries the standard `data-tauri-drag-region` attribute (on the bar and on its non-interactive parts, never on a button or link). The
update commands are optional as a group: when `update_state` rejects at start, the SPA treats the shell as one without updates. A
payload that is not an `UpdateState` is dropped; a command that rejects shows as an error of the updater. What the shell sets in
the server's environment: `QM_MIGRATIONS_DIR`, `QM_DIST_DIR`, `QM_STDIN_CONTROL=1`, `QM_CSP_CONNECT` (`docs/app.md` "The sidecar").

**The frameless window.** Only with `shell.available`: in the singleuser variant the slim bar is the title bar (drag region, the chip,
the window buttons; the logo's row of the side bar is a drag region too); in the online variant the top bar is (drag region; double
click maximizes, the shell's doing) with the three window buttons (`WindowButtons.vue`: minimize, maximize or restore, close; 36 px
slots, close hovers in the error colour) at its right end; where the app bar is not shown (the start tile, the server not reachable)
`TitleBar.vue` gives a bar with the buttons alone; `WindowEdges.vue` puts eight invisible 6 px strips along the edges (none while
maximized). The top bar's window buttons sit absolutely at the top right (the bar keeps 128 px of right padding), so a wrapped bar keeps
them in its first row; up to a window width of 1400 px the wordmark, the tab padding and the gaps give way so the bar stays one row at
1280 px. The settings window has `TitleBar.vue` with its title and the close button, no edges.

**The app footer and the update dialog.** With `login: 'none'` the footer starts with the app version (mono, 22 px high). Where the shell
offers updates it is a button opening the dialog and a mark (the download arrow in the accent colour; its room is kept when empty) follows
it while a version was found (`available`, `downloading`, `installing`); in a browser the version is plain text. The dialog
(`UpdateDialog.vue`, "App Update"; also opened by the bold notice's button and the App group's "App Update" button in the settings,
which exists only with the shell; from the settings window the main window opens it, "The two windows") shows the channel select in the head (disabled while busy), the current and available version as
chips, the notes in a box of fixed height (kept when empty) and one status line of fixed height ("Checking …", "Downloading …" with the
percent and a progress bar, "Installing …", or the error text in the error colour). Buttons (`updateButtons` in `shellLogic.ts`):
Close always first on the left; then "Check Update" in idle, current, checking and error (disabled while checking) or "Install" in
available, downloading and installing (disabled while downloading and installing); the two share one button's room
(`ConfirmButton.reserve`). Closes by its button or Escape only. Tests: `test/webapp-shell.test.ts`.

Tests: `test/webapp-local.test.ts` (start tile states including the timeout rule, navigation per capability, the settings
decisions, time formatting, both languages having the same texts).

### Layout and building blocks

- List views share one layout: Ressourcen and Blueprints have the scope switch above (`ScopeBar.vue`: big
  buttons personal, each org, optionally "All"; always shown, also without any org, but not without the `orgs` capability; `scopeName` for heads),
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
  stay at the right edge. Table actions are icon buttons with a tooltip; table filters say "Filter…". Every
  cell of a `.table .data-row` shows its text as tooltip (`webapp/src/cellTips.ts`, one global `mouseover`,
  set on hover), except cells with an info card (the names), buttons or a `title` of their own.
- Dialog buttons always sit in the footer (`ConfirmDialog`); a `ConfirmButton` with `form` submits a form in
  the body (Enter works). Pickers: `webapp/src/components/Picker.vue` (lists every match, the list scrolls);
  `Dropdown.vue` is BindSight's with prefixed variant classes (`dd-chip`, …: ui.css has global
  `.chip`/`.outline`/`.small`). Toasts top right below the top bar (`TopBar.vue`, in the singleuser variant `SlimBar.vue` and the settings
  window's title bar measure their height into `layout.ts` `topbarHeight`, `Toasts.vue` sets `top` from it; a CSS variable failed after a full reload).
  Error codes mapped in `i18n.ts`; amounts validated with the server's own `parseAmount`.
- Icons on tabs, buttons and panel heads like BindSight (extra icons in the shared
  `adminapp/src/components/Icon.vue`); no counters in panel heads (only next to filters).
- Item thumbnails (`Thumb.vue`, lookups in `webapp/src/thumbs.ts`: a material by its uuid, a blueprint by the
  item it crafts): a fixed box, `<img>` lazy; without a hash or when loading fails the type icon in the same
  box. The S thumbnail (20 px) stands where the type icon stood before the name: Ressourcen/Ausrüstung group
  rows, Raffinerie material rows, Blueprints names, History targets, the Bergbau table's ore column. The
  Crafting card's head is the crafted item's info tile (`InfoTile.vue`, L thumbnail at 128 px).
  Info cards (`InfoTip.vue`) show the L thumbnail at 128 px left of the text (above it below 560 px wide),
  loading from the start of the hover, so it is there when the card opens.
- List views: every table (Ressourcen, Ausrüstung, Raffinerie, Blueprints, History; Bergbau not since 2026-11-01) has the view
  toggle (`ViewToggle.vue`, right of the column chooser or the last filter): "Kompakt" (default) or
  "Thumbnails" (`.table.view-thumbs`: rows at least 48 px, 14 px text, a first column with an empty head,
  `THUMB_COLUMN`, the M thumbnail at 48 px instead of the small one before the name; Ressourcen/Ausrüstung on
  group rows only, Raffinerie on material rows only). Kept per table with its columns (`useTableColumns`
  `view`); `DataTable` adds the column with `thumbs` (cells from `#cell-thumb`).

### UI rules

- Buttons, chips and toggles keep their size when their state changes: state switches must not alter button dimensions
  anywhere in the UI (texts via a swap, equal variant borders).
- `assets/logo.png` is the app/bot logo. Its web copies (regenerate when it changes): `adminapp/src/assets/logo-128.png`,
  `adminapp/public/favicon.png`, `webapp/src/assets/logo-256.png` (login page), `webapp/src/assets/logo-{72,144}.png` (Companion
  dialog), `webapp/public/favicon.png`, `companion/src/assets/logo-{44,88}.png` (the companion's title bar; exact sizes, Lanczos: the webview's own downscaling frays the edge).

## Security measures

| Vector | Measure |
|---|---|
| CSRF | Session cookie SameSite=Lax; own same-origin check on every non-GET; writes accept `application/json` only (a JSON body cross-origin needs a CORS preflight, never answered); no state change on GET. Same-site is not enough: admin (`:8443`) and user app are the same site. |
| XSS | Vue escapes; no `v-html` except `Icon.vue` (constants; enforced by `test/spa-sources.test.ts`). Untrusted texts: external `global.ini` files, Discord names. Strict CSP from the app (`connect-src` is `'self'` and the WebSocket; `WebappConfig.extraConnectSrc` adds sources, unset online; the singleuser entry fills it from `QM_CSP_CONNECT`, which the desktop shell sets to the one origin its IPC needs, `http://ipc.localhost` on Windows: `docs/app.md`). |
| Clickjacking | `frame-ancestors 'none'`, `X-Frame-Options: DENY`. |
| Access control / IDOR | `Actor` only from the session + roster; a `guildId` from the request only with an active member row there; reads through functions that take the `Actor`, never "load by ID"; writes through the stock service only. DB tests cover other users' stock, other orgs, inactive members. |
| Missing auth | Auth middleware on everything except `/auth/*`, `GET /api/capabilities` (no user data: what the server offers) and static files; a test asserts 401 for every other route without a session. |
| Injection | Parameterized `sql` templates, Zod for every body/query/param, 16 KB body limit, amounts via `parseAmount`. |
| Session theft | HttpOnly, Secure, HSTS (Caddy), hashed tokens, no Discord tokens stored, `Referrer-Policy: no-referrer`, `no-store` on API responses (the catalog, game data only: `private, no-cache`). |
| Abuse | Rate limits in memory (one process): `/auth/*` per IP, `/api/*` per session. |
| DB privileges | Own role `qm_web` (see `docs/deploy.md` "DB roles"): no writes to `app.org`/`app.member` (role IDs, roster) nor `app.user_privilege` (who holds a privilege), no access to schema `bot`. |
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
