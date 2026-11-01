# Admin web UI

Requirements: `docs/requirements.md` "Admin web UI". Commands: `CLAUDE.md`.

The operator's control room (rebuilt 2026-10-22): is everything running, is it used, do the data hold. The
catalog browser stays, in its own group. Read-only on user data; the only writing features are the imports (and
removing imported text sources), the bot's status texts and assigning privileges.

- **API** (`src/adminapp/main.ts`, Hono): one process, bound to `127.0.0.1` by default (in the container
  `0.0.0.0`, published on the host's loopback only), HTTP basic auth for everything (API and static SPA).
  Read endpoints under `/api`, response types in `api-types.ts`. Writing endpoints require the header
  `X-Quartermaster: 1` (CSRF protection: a foreign form cannot set it): the status texts (page Bot) and the
  imports (`/api/import/catalog`, `/api/import/localization`), which take the file as raw body and are a dry
  run unless `dryRun=0`. The catalog import requires `label` (the game version, e.g. 4.10.2; 400 without; the
  CLI likewise requires `--label`), the SPA's dry run stays disabled until it is set. The SPA uploads via XHR
  and shows the upload's progress, then a spinner with the seconds the server has been working (no further
  progress: one transaction). Serves `adminapp/dist` with SPA fallback. Both imports use the same functions as
  the CLIs (`docs/catalog-sources.md`). In schema `web` it reads only the columns `deploy/db-roles.sh` grants
  qm_app (never token hashes).
- **SPA** (`adminapp/`): look and building blocks taken from BindSight (design tokens, fonts, `Dropdown`,
  `ColumnHead` + `tableColumns.ts` resizable/sortable grid tables), shared classes in
  `adminapp/src/styles/ui.css` (the user web app and the companion import them too, as `Icon`, `DataTable`,
  `Tooltip`, `Dropdown`: change those only compatibly). Layout: a left sidebar (`SideNav.vue`; groups
  Operations, Community, Stock, Catalog, Sources, Apps; folds to its icons, remembered per browser; Status
  carries the number of check hits) and a top bar with the page's name, the imported game build (links to
  Imports) and the text language. GUI text is English and terse. Game texts follow the language picker
  (`lang.ts`). Catalog lists load completely and filter/sort in the browser; the text search runs on the
  server. Help texts live in `adminapp/src/help.ts` (`HelpTip`); technical values (keys, class names, hashes)
  are only shown in tooltips (`Tooltip`). Ordering rule: by priority where there is one, else by amount
  (largest first), else alphabetical. Item type icons: `adminapp/src/typeIcons.ts`. Charts are small own SVG
  components (`Sparkline.vue`, `DayBars.vue`), no chart library. Old paths redirect: `/resources` →
  `/materials`, `/localisation` → `/texts`, `/3rd-party` → `/uex`.
- **Gear** throughout the admin = ship components and FPS gear by item type (`isComponentType` /
  `isFpsType`, SQL `fpsTypeSql`, `src/catalog/components.ts`), without the stock service's plain-part rule;
  harvestables = the other items.

## Operations

- **Dashboard** (`/`, `GET /api/dashboard?days=7|30|90`, `src/adminapp/activity.ts`, tested in
  `test/admin-activity.db.test.ts`): a health strip (no catalog import → error, link Imports; UEX without
  data → warning, else one entry with the worst endpoint state; every logs channel not ok; every data check
  with hits, link Status; empty = "All good"), KPI tiles (active users and actions 7 days with 30-day
  sparklines and the share per source, orgs with the bot and their active members, stored batches/SCU/pieces
  and gear pieces, refinery jobs running/ready, blueprints owned and the companion's blueprint adds), actions
  per day stacked by source, the 12 latest actions as a table (time, source, action, by, target, amount, org),
  the sources' state, the orgs and reach (known users, in an org, holding data, web login within 30 days —
  sessions are deleted after 14 idle days, so in effect 14 —, companion used within 30 days; each step counted
  on its own, not nested). Days are UTC days, the 7-day values rolling. Reloads on Refresh and when the window gets the focus back.
- **Status** (`/status`, `GET /api/status`, `src/adminapp/status.ts`, tested in `test/admin-status.db.test.ts`):
  services (the catalog's game build and import age, the UEX pull per
  endpoint: warning after 35 minutes without a check, error after 2 hours; the bot's logs channels: history
  rows the channel would post that the bot has not worked off yet, from `logRows` against
  `bot.guild.logs_after` — the bot keeps no heartbeat —, warning after 2 minutes, error after 10, "No mark"
  while it has not set its mark), the user data checks (`GET /api/checks`, every check listed also without
  hits: stock of retired materials, stock at retired locations, registered retired blueprints, jobs outside the UEX refineries) and the catalog (counts, texts
  missing per language, blueprints without a known source and those registered anyway, without output; `GET /api/overview`) and the item thumbnails (`GET /api/thumbs`, `src/adminapp/thumbs.ts`:
  how many of the renderer's targets — gear items by the stock service's rule, materials with a thumbnail entity
  — have one, when `thumbs.json` was written, the targets without one by name, linked; after a game patch's
  import the new items show up there until the next render). The catalog's detail panels (items, materials,
  blueprints: the crafted item) show the large thumbnail; the admin serves `/thumbs/…` itself from `THUMBS_DIR`
  (the web app's directory, mounted read-only), behind its basic auth.
- **Activity** (`/activity`, `GET /api/activity`, `src/adminapp/activity.ts`): every `app.history` row, newest
  first, "Load more" by id cursor (`before`, `limit` ≤ 200); filters source, category, action, org, user (actor,
  owner or recipient), days. All filters live in the route query (`/activity?user=<id>`, `?guild=<id>`,
  `?days=7&source=companion`): other pages link there. A row unfolds its raw `details`. `app.history` has no
  index on `created_at`: the day series scan the table, fine at today's size (a later migration if it grows
  into the hundreds of thousands, or filter by id ranges).

## Community

- **Users** (`/users/:userId?`, `GET /api/users[/:userId]`, `src/adminapp/users.ts`, tested in
  `test/admin-users.db.test.ts`): everyone in `app_user`, `web.session` or `web.api_token`; channels (sources of
  their own actions in the last 30 days), stored batches, SCU, harvestable and gear pieces, refinery jobs,
  blueprints, last action, last web login, companion token. Detail tabs (remembered per browser): Overview
  (identity, web sessions and token, actions per source in 30 days, memberships), Stock (Resources /
  Harvestables / Gear), Refinery (running jobs with their refined materials, expected yield and quality),
  Blueprints, History (newest 50 rows, link to Activity). Names (`userNames`): the newest web session's
  Discord profile, else the companion token's, else the org nickname, else only the ID.
- **Orgs** (`/orgs/:guildId?`, `GET /api/orgs[/:guildId]`): bot presence, settings (language, logs, board),
  active/inactive members, batches shared there by active members, last history row naming the org. Detail
  tabs: Roster, Shared stock (grouped like a user's), Bot (presence, language, logs channel and level with
  the logs state from `/api/status`, board channel/message/style/title/subtitle), Activity (newest 20 rows
  with this `guild_id`, link to Activity).
- **Privileges** (`/privileges/:key?`, `src/adminapp/privileges.ts`, tested in `test/webapp-features.db.test.ts`;
  the system: `docs/webapp.md` "Privileges"): the keys (from the migrations) with their description, holders in
  force and entries. The detail: holders (since, expiry, expired ones marked) and the feature's rows (a UUID subject
  with the catalog's name, the author, the current thumbnail next to the reference image, "Re-rendered" when the
  mark's hash differs). "Export ZIP" (`GET /api/privileges/:key/export`, `zip.ts`, uncompressed): `entries.json`
  (key, description, one object per row with subject, name, class, type, author, payload, current thumbnail
  hash, `stale`, image path) and `images/<subject>_<userId>.<ext>`: unpacked into `local/` it is what Claude reads
  to fix the renders. Assigning lives in **Users**, tab Privileges: every key not retired with its state
  (Held / Expired / Not held), assign (`PUT /api/users/:id/privileges/:key` `{ expiresAt }`), an expiry date (end
  of that local day, empty = never) and take back (`DELETE`, confirmed; the user's rows stay).

## Stock

- `src/adminapp/stock.ts`, tested in `test/admin-stock.db.test.ts`.
- **Stock** (`/stock`, `GET /api/stock`, `GET /api/stock/:kind/:uuid`): stored stock over all users, one row
  per subject, tabs Resources (materials and harvestables) and Gear (ship components and FPS gear: no quality,
  instead the batches with stats); owners, batches, shared batches and orgs (every `stock_share` row, also of
  orgs the owner has left). Detail via `?subject=<kind>:<uuid>`: every batch incl. refinery jobs (so its sum may
  exceed the list's stored total), lot, orgs, stats by name formatted like the crafting check.
- **Refinery** (`/refinery`, `GET /api/refinery`): every job with owner, station (`atRefinery` by
  `refineryLocations`; without UEX data every location counts), materials, total SCU, end and state (`open` =
  no end, `ready` however long ago, `running`); state chips, a station filter
  with the job counts.

## Catalog

- **Blueprints**, **Materials** (`catalog.resource`), **Items**, **Texts**: list + detail as before. Blueprints
  shows the recipe facts above the table (default, quality-gated, slot choice, craft times, materials and items
  in recipes, the last import's changes). Items has group chips Gear (Ship / FPS) · Harvestables (non-gear
  items an active recipe uses) · Other, combined with the other filters (the SPA imports
  `src/catalog/components.ts`, listed in `adminapp/tsconfig.json`).
- **Mining** (`/mining/:uuid?`, `GET /api/mining[/:uuid]`, `src/adminapp/mining.ts`): every mining provider
  (`catalog.mining_provider`) with its places (the first two and the count when there are many), systems,
  methods and resource count; method chips (Ship, ROC, FPS) and the search. The detail lists the yields per
  method (resource and gem item linked to Materials/Items, share of the method's rocks, content, rarity,
  quality factor of the part, quality values with their chances) and every place with its system and key. Places and systems as the web app names
  them (`starMap`). See `docs/catalog-sources.md` "Mining"; its anomalies show in the Imports detail.

## Sources

- **Imports** (`/imports/:id?`): the forms, the catalog import list with its detail, and the text sources
  (every source × language from `GET /api/localization/sources`, by priority; reloads after an import via the
  meta reload). Imported sources can be deleted (trash icon, browser confirm; `DELETE
  /api/localization/sources/:source/:lang`, `X-Quartermaster: 1`, like `loc:import --remove`); `game` and `app`
  cannot. Catalog imports cannot be deleted: catalog rows reference them (first/last seen).
- **UEX** (`/uex`): see `docs/ext.md`.

## Apps

- **Bot** (`BotView.vue`, `src/adminapp/status-quotes.ts`, tested in `test/bot-status.db.test.ts`): the
  bot's status texts (`docs/bot.md`, `status.ts`): add, edit inline, delete (browser confirm). API
  `GET /api/status-quotes`, `POST /api/status-quotes`, `PUT /api/status-quotes/:id` (JSON `{ text }`, trimmed,
  1–128 characters), `DELETE /api/status-quotes/:id`; the writing ones require `X-Quartermaster: 1`. Below, a
  read-only "Servers" table of every `bot.guild` row (from `/api/orgs`), rows link to the org.
