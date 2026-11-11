# Singleuser variant

Five parts are described here: the process (how it starts and what it keeps), the database (PGlite), the settings and the game folder, the data pack (how
game data gets into the app, and how the app fetches it) and who the user is (the local identity).

# The process

`src/singleuser/main.ts` is the variant's composition root: one local process that serves the web app (the built SPA,
`webapp/dist`) and its API on PGlite for the one fixed user.

```sh
pnpm singleuser                                   # the server
pnpm singleuser:import <pack.zip>                 # installs a full data pack into the same data folder ("The data pack")
pnpm singleuser:import <snapshot.json.gz> [opts]  # the catalog import into the same data folder (catalog:import's options; development)
```

The SPA must be built (`pnpm webapp:build`). **One process per data folder:** PGlite has no second opener, so the server
and `singleuser:import` must not run at the same time on one folder (use `QM_DATA_DIR` for a second folder).
`singleuser:import` migrates a fresh folder first, imports (a `.zip`, by extension or by its first bytes, is a data pack and goes
through `installPack`; anything else is a snapshot for `catalog:import`), then runs `maintain()` (CHECKPOINT and VACUUM).

| Variable | Meaning |
|---|---|
| `QM_DATA_DIR` | the data folder; else `%LOCALAPPDATA%QuarterMastersingleuser` (Windows) or `${XDG_DATA_HOME:-~/.local/share}/quartermaster/singleuser`; created if missing |
| `QM_PORT` | exactly this port, or the start fails; else the first free one of 28460-28469 (tried by listening on 127.0.0.1) |
| `QM_THUMBS_DIR` | the thumbnails folder (`s/`, `m/`, `l/`, `thumbs.json`); else `<data folder>/thumbs`, which may be missing (no thumbnails then) |
| `QM_AUTO_UPDATE` | `0` = no automatic data update (no request at start), overriding the setting `autoUpdate`; anything else or unset = the setting decides. A check asked for through the API still runs |
| `QM_GAME_DIR` | the game folder, overriding the setting `gameDir` (development, tests) |
| `QM_PAIRING_FILE` | the pairing file's path instead of the profile's (development, tests) |
| `QM_DATA_FEED` | a folder (`channels.json`, `<tag>/<asset>`) the data update reads instead of GitHub; for development and tests |

(`src/singleuser/paths.ts`, `port.ts`: pure, passed the environment; tested in `test/singleuser-helpers.test.ts`.)

**Data folder:** `settings.json` (the settings, "Settings and the game folder"), `db/` (the PGlite database, with its `pg_wal/`), `thumbs/` (`s/`, `m/`, `l/`, `thumbs.json`) and `data-pack.json`
(the manifest of the installed data pack); the last two are written by the data pack's install. `downloads/` exists only
while the data update downloads (deleted afterwards and at the next start). Nothing else.

**Start:** the server binds to `127.0.0.1` only; its origin is `http://127.0.0.1:<port>`. It logs one line per loading
step with its duration (`open database`, `migrations`, `checkpoint`, `listen`) and then
`listening on <origin>`. The migrations run at every start (a no-op when current), then one `CHECKPOINT`; there are no
timers. Capabilities: `{ login: 'none', orgs: false, uex: false }`. The rate limits are set so high that one local user
never meets them. Realtime is the online mechanism: the same triggers and `listenForChanges`, with the PGlite
connection as the change source.

**Stop:** SIGINT or SIGTERM stops accepting, closes the realtime sockets and the server, awaits the PGlite close and
exits (at most 10 s, then it leaves anyway). `test/singleuser.test.ts` starts the real process on a temp folder (no
Postgres) and drives it, through `test/singleuser-runner.mjs`, which turns a line on stdin into SIGINT because a
Windows child cannot be sent a catchable signal.

**Host guard (DNS rebinding):** a web page whose domain is re-pointed to 127.0.0.1 is same-origin to the browser, and
would reach everything the open local API offers. The app therefore answers 421 `{"error":"host not allowed"}` to every
request whose `Host` header is not in `WebappConfig.allowedHosts` (the first middleware; unset = no check, as online,
where Caddy matches the host), and the WebSocket handshake (`RealtimeOptions.allowedHosts`) is refused with 421 the
same way. The composition root passes `127.0.0.1:<port>` and `localhost:<port>`. A GET or HEAD page request on a
host of the list that is not the origin's (`localhost`) is redirected (307) to the origin, so the SPA always runs on the
origin the WebSocket and the write checks expect; `/api`, `/auth`, `/thumbs` and `/downloads` just work on both
hosts. Tests: `test/webapp-host.test.ts`.

**Companion label:** a request with the companion's `X-QM-Companion` header is booked as `companion` in the history,
any other as `webapp`. It is a label, not a security decision: the local API is open anyway.

**Network:** the data update ("Updating the data") is the only thing in this process that makes a request, and only to GitHub (or
to `QM_DATA_FEED`, a folder). After "listening" a check starts in the background when the automatic update is on; the start
never waits for it. Its steps are logged one line each with their duration (`data update: check`, `plan`, `download <MB>`,
`install`, the outcome). At SIGINT or SIGTERM a download is aborted (its partial file deleted) and an install in progress is
waited for (up to 120 s instead of 10).

**What the variant does not have:** orgs (no org routes, no membership), login and sessions, API tokens, the Discord bot,
the admin UI, the UEX pull.

# Settings and the game folder

`src/singleuser/settings.ts`, `game-folder.ts`, `pairing.ts`, `settings-routes.ts`; `main.ts` reads them at start. Dependencies are passed in
(the file, the environment, the log function).

## Settings

`<data folder>/settings.json`, a zod schema; unknown keys are dropped, a missing key takes its default:

| Key | Default | |
|---|---|---|
| `gameDir` | `null` | the game folder: the channel folder, e.g. `...\StarCitizen\LIVE` |
| `autoUpdate` | `true` | the one switch for the automatic update of app and data (read at start) |

A missing file is the defaults; a broken one (not JSON, wrong types) is the defaults and one logged warning. A write goes
through a temp file and a rename. `QM_GAME_DIR` and `QM_AUTO_UPDATE=0` override the values (development, tests): they are
reported as overridden, never written to the file, and the API refuses to change an overridden value (409).

## The game folder

Mandatory for the app, as for the companion. It is valid when it is an absolute path to a folder holding `Data.p4k` and
`build_manifest.id` (`checkGameFolder`; the problems are `notFolder`, `noDataP4k`, `noBuildManifest`). The game version
is `gameLabel` of `build_manifest.id`; an unreadable manifest only means no version. **Nothing in the game folder is ever
written, created or locked**, and nothing in it makes a function throw.

## The language pack

One user is one `global.ini` is one language; no language of game texts is chosen anywhere. The rule is the companion's
(sc-ohseearr `locale::pack_path`, `language_of`), read on the server side:

- the language is the `g_language` of `<game folder>/user.cfg`: per line everything from the first `;` on is a comment,
  `key = value` split at the first `=`, the key case-insensitive, the value trimmed (quotes are not special); a line
  with an empty value is skipped, the first one with a value wins. No `user.cfg` or no language in it: `english`;
- the file is `<game folder>/data/Localization/<language>/global.ini` (`Data` when there is no `data` folder: Linux);
- parsed with `parseIniFile` (UTF-8 or UTF-16, keys lower case, "translation not found" placeholders dropped).
  A language that is not a plain folder name (a path) is treated as having no file.

The result (`readLanguagePack`) is the language, the file, the texts and a `problem` that is never fatal (the app then
shows the game's English): `noUserCfg`, `noLanguage` and `builtInEnglish` (English set, no file: the game's English
is inside `Data.p4k`) are the normal English case; `iniMissing` (another language, no file), `iniUnreadable` and
`iniEmpty` (not one usable text: that is the check for "obviously not a `global.ini`") are real problems.

**Read at start only:** no watcher, no button; a changed game folder or `user.cfg` applies at the next start. The start logs
one line each for the folder (state, version) and the pack (language, number of texts or why none), with their durations.
The composition root holds the result as `languagePack`.

### How the pack reaches the texts

`syncLanguagePack` (`language-pack.ts`) stores the pack as the localization source `language-pack` (`catalog-sources.md`
"Localization") and runs at every start after the migrations, **before the server listens**: no request is answered with
a stale state, and nothing computed at start has cached texts before it. The source has priority 500 (above `game` = 0, below
`app` = 1000), `origin` = the pack's file, the content hash `textsSha256` of all its texts. It is reserved: `loc:import`
refuses the name. The `loc:import` guards (overlap, mass removal) do not apply; the player's file is taken as it is, minus what
`readLanguagePack` already drops (placeholders, the app's `qm_` keys). In one transaction the outcome is one of:

| Outcome | When | Writes |
|---|---|---|
| `unchanged` | the stored hash equals the pack's | nothing at all |
| `written` | no source yet, or another hash | only the added and changed texts, the vanished ones deleted, the source row updated; then `maintain()` |
| `removed` | no pack: game folder unset or invalid, no file, or an unusable one | the source (its texts go with it); then `maintain()` |
| `none` | no pack and no source | nothing |

The start logs one line (`language pack sync: <outcome>, <n> texts (<added/changed/removed>) (<ms> ms)`). The first sync of a
full English pack (about 91,000 texts) took about 3 s and added about 25 MB to the data folder; a start with an unchanged file
takes under 0.1 s.

**The language rule:** the pack's texts are stored under `en` whatever the pack's language, because `locText` asks the effective
texts of the requested language first and those of `en` second, and the snapshot holds English game texts only. A `de` lookup
finds no `de` text (but the app's own `qm_` ones) and falls back to the effective `en` text, so the pack wins in both UI
languages, and a key the pack lacks shows the game's English in both. No query knows the source. The app's own texts (source
`app`, German and English) are not touched and follow the UI language. A catalog import (data pack install) writes the `game`
source only and leaves the pack alone.

`GET /api/local/settings` reports `languagePack.active` (the loaded pack is in effect) beside `language` and `texts`; a UI says
"active with N texts in language X" for `loaded` and `active`, nothing for `none`, a problem sentence for `problem`.
Tests: `test/singleuser-language-pack.test.ts` (PGlite, the real routes for both `lang` values), the process in `test/singleuser.test.ts`.

## Pairing with the companion

`pairing.json`: `%LOCALAPPDATA%\QuarterMaster\pairing.json` (Windows), `${XDG_DATA_HOME:-~/.local/share}/quartermaster/pairing.json`
(Linux), or `QM_PAIRING_FILE`. Content `{ "format": 1, "origin": "http://127.0.0.1:<port>", "gameDir": "<folder or null>" }`
(`pairingSchema`); no token, the local API is open. Written (atomically) when the server listens, rewritten when the game
folder setting changes, deleted on a clean exit; after a crash a stale file stays (the companion then gets "connection
refused"). A failing write or delete is logged and never stops the server.

## Endpoints

Singleuser only, mounted through `WebappConfig.mountApi` (types in `src/webapp/api-types.ts`, `LocalSettingsState`):

| Request | Answer |
|---|---|
| `GET /api/local/settings` | `{ gameDir, autoUpdate, overridden: { gameDir, autoUpdate }, gameFolder: { state, problem?, gameVersion? }, languagePack: { state, language?, texts?, active?, problem?, pending } }` with `gameFolder.state` one of `unset`, `invalid`, `ok` and `languagePack.state` one of `none`, `loaded`, `problem` |
| `PUT /api/local/settings` `{ gameDir?, autoUpdate? }` | stores, answers the new state like the GET. `gameDir` must pass the check or be `null`, else 422 `{ error: 'gameFolderInvalid', problem }` and nothing changes; an overridden value is 409 `{ error: 'overridden', keys }`; anything else wrong is 400. A changed `gameDir` re-checks the folder and its version at once and rewrites the pairing file |

`languagePack.pending` is true when the game folder is no longer the one the pack was read for: it is read again at the next
start (a UI says so in one sentence). `autoUpdate` applies at the next start too. Tests: `test/singleuser-gamefolder.test.ts`,
the process in `test/singleuser.test.ts`.

# The database

The singleuser variant runs the same code as the online one on **PGlite** (`@electric-sql/pglite`): Postgres compiled to
WASM, running inside the Node process, its data in a folder (or in memory). Online stays on Postgres through postgres.js;
the online entry points (`src/webapp/main.ts`, `src/bot/main.ts`, `src/adminapp/main.ts`, `src/ext/main.ts`) call
`connect()` and never load PGlite.

## Connections

| Piece | What it does |
|---|---|
| `src/db/pglite.ts` | `connectPglite(dataDir?, options?)` → `{ db, client, migrate, maintain, close }`. `dataDir` null/undefined = in memory. |
| `src/db/connect-url.ts` | `connectUrl(url)` → the same shape for both engines: `pglite:memory` and `pglite:<dir>` go to PGlite, everything else to `connect()`. Used only by the CLIs that work on both (`db:migrate`, `catalog:import`, `loc:import`) and by the test helpers. |
| `ChangeSource` (`src/db/client.ts`) | What LISTEN needs: `listen(channel, onNotify, onListen?)`. postgres.js (`connect().client`) and the PGlite connection's `client` both satisfy it; `listenForChanges` (web app realtime) and `listenForBoardChanges` (bot) take it. The migrations' triggers send `pg_notify('qm_changes', …)`. |

- **Rows:** drizzle's PGlite driver returns a result object from `execute()`, postgres.js the rows array, and the code base
  uses the rows (also on transaction objects). The PGlite connection unwraps them in one place (a Proxy around `db` and
  each `tx`).
- **One instance per data dir and process:** `connectPglite` on a dir that is already open returns a connection to the
  same instance; `close()` closes PGlite when the last connection of the dir is closed (await it before opening the dir
  again). A connection's `close()` can be called twice. In memory the same rule holds: the database is gone with the
  last connection.
- **Migrations:** `migrate(folder)` runs drizzle's migrator for the engine (`drizzle-orm/pglite/migrator` or the
  postgres.js one); all migrations of `drizzle/` run on PGlite.

## The one-connection rule

PGlite has **one** connection. While a transaction is open, a query on the outer `db` waits for that transaction, and the
transaction waits for the caller: a deadlock that looks like a hang. On the PGlite side the outer `db` therefore throws at
once when used inside a transaction callback (tracked with `AsyncLocalStorage`), naming the method:
`db.execute() was called inside a transaction … use the transaction object (tx) instead`. Use `tx` inside the callback.
Online the same mistake merely runs on another connection, so the guard exists on the PGlite side only. Code that needs a
second connection on purpose (a concurrent writer) cannot run on PGlite.

## Settings

Passed through the constructor option `postgresqlconf` (`name=value` strings); `options.postgresqlconf` replaces a default
of the same name:

| Setting | Default | Why |
|---|---|---|
| `max_wal_size` | `32MB` | the WAL recycles at this size; unbounded it grows into the hundreds of MB during imports |
| `min_wal_size` | `32MB` | the same |
| `shared_buffers` | `16MB` | measured about 105 MB process memory instead of about 260 |

The settings are written into the data dir at every open. In-memory instances ignore them (stock configuration).

## maintain()

Nothing checkpoints or vacuums by itself in PGlite (no background writer, no autovacuum). `maintain()` runs `CHECKPOINT`,
then `VACUUM` (two statements: `VACUUM` does not run in a multi-statement exec). Callers invoke it after big writes
(imports); there are no timers, and it must not be called inside a transaction. On Postgres, `connectUrl(...).maintain()`
does nothing (autovacuum).

An instance that ran `CHECKPOINT` or `VACUUM` and is not closed keeps the process alive for about 10 seconds: close the
connection.

## Tests

```sh
pnpm test:pglite     # the whole suite on PGlite: TEST_DATABASE_URL=pglite:memory (test/pglite.env, loaded after .env)
TEST_DATABASE_URL=pglite:/some/dir node --env-file-if-exists=.env --test test/stock.db.test.ts   # one file, on disk
```

Each test file is its own process with its own in-memory database; `prepareDb` migrates it. Skipped on PGlite, with the reason
in the report: the second-connection test of `test/bot-roster.db.test.ts`. `TEST_ROLES=1` needs Postgres.
`test/pglite.test.ts` tests the connection itself (rows, guard, `maintain()`, `listen`, a data dir across close and reopen).

# The data pack

The variant ships without game data. Game data comes as a **data pack**: the catalog snapshot (without its raw records)
and the item thumbnails, published as a GitHub release of this repository and installed into the data folder
(`src/datapack/`; the app fetches releases itself: "Updating the data").

## The release

Tag `data-<game label>-<n>`, e.g. `data-4.10.2.12913470-1`: the label is `snapshot.game.label`, `n` (1, 2, …) counts
re-issues for the same game version. Four assets:

| Asset | What |
|---|---|
| `manifest.json` | the manifest (below) |
| `quartermaster-data-<label>-<n>.zip` | the **full pack**: one ZIP without compression holding `manifest.json`, `catalog.json.gz`, `thumbs.json` and the pictures `s/`, `m/`, `l/` |
| `catalog.json.gz` | the slim snapshot: the v7 snapshot without its `rawRecords` array (the schema reads an absent array as empty) |
| `thumbs-update.zip` | a ZIP without compression: the complete `thumbs.json` and only the pictures that are new against the predecessor release; the first release holds every picture |

A picture is `<size>/<uuid>.<hash>.avif` (`src/thumbs.ts`; content-addressed: the same name is the same content), three
per item in `thumbs.json`. "New" is: that file name is not in the predecessor's set (its complete `thumbs.json`, read from
its `thumbs-update.zip`). Only pictures `thumbs.json` names go into a pack.

**Manifest** (`src/datapack/manifest.ts`, zod): `format` (1), `tag`, `previous` (the predecessor's tag, null for a first
release), `game` { `label`, `build` }, `schemaVersion` (the snapshot's), `files` { `full`, `catalog`, `thumbs` }, each
`{ name, size, sha256 }`, `thumbs` also `count` (pictures in `thumbs-update.zip`). **Rule for `files.full`:** the copy of the
manifest inside the full pack is the standalone one except that its `files.full` carries the name and the placeholders
`size: 0`, `sha256` = 64 zeros (an archive cannot hold its own hash). `files.full` is verified only for the downloaded
asset, against the standalone manifest (the updater's job). A full pack the user picked has no standalone manifest: it is
checked by the CRC-32 of every entry and by `files.catalog` (the catalog's size and sha256).

## Building: `pnpm data:pack`

```sh
pnpm data:pack --snapshot <file> --thumbs <dir> --n <number> --out <dir> [--previous <dir>]
```

The snapshot is a v7 snapshot, full or slim; `--thumbs` holds `thumbs.json`, `s/`, `m/`, `l/` (`thumbs:build`); `--previous` is a
folder with the predecessor's assets (its `manifest.json` and `thumbs-update.zip`, the latter checked against the former).
It prints the tag, every asset with size and sha256 and how many pictures are new of how many. A picture that
`thumbs.json` names and the folder lacks is an error naming it. **Reproducible:** the same input gives the same bytes
and hashes (with the same Node/zlib): entries sorted by code point, ZIP entries dated 1980-01-01 (`ZIP_EPOCH`), JSON from a
fixed key order, `thumbs.json` rewritten canonically (sorted, compact), gzip level 9 with the header's OS byte pinned
(zlib writes the platform's code there otherwise).

## Installing: `installPack`

`installPack({ connection, dataDir, thumbsDir, source })` (`src/datapack/install.ts`): `connection` is `{ db, maintain }` of a
connection, `thumbsDir` is `<dataDir>/thumbs`. `source` is a full pack (`{ kind: 'full', file }`) or the parts the updater
hands over (`{ kind: 'parts', manifest, catalog, thumbsUpdates }`: the parsed manifest, the `catalog.json.gz` file, the
`thumbs-update.zip` files oldest first). `pnpm singleuser:import <pack.zip>` installs a full pack. Order:

1. **Validate, touching nothing:** the manifest (format known, else `DataPackError` `unknownFormat`; schema valid);
   `schemaVersion` is the app's `SNAPSHOT_SCHEMA_VERSION`, else the **result `appTooOld`** (the caller says "update the app")
   and nothing else happens; the catalog's size and sha256 against `files.catalog`; in parts, the newest thumbs update
   against `files.thumbs` (size, sha256, `count`; older ones are checked by the caller against their own manifests); the
   archives' entries: names must be safe (no `..`, no absolute path, no backslash, no drive, no duplicates; checked when
   an archive is opened) and exactly the expected ones (`manifest.json`, `catalog.json.gz`, `thumbs.json`, `<s|m|l>/<uuid>.<hash>.avif`
   named by `thumbs.json`), stored only, every entry's CRC-32 on reading; the catalog loads and its game label and build are
   the manifest's; every picture `thumbs.json` names is in a given archive or on disk already (else `incomplete`: a link of the
   chain is missing). Refusals are `DataPackError` with `code` `invalid`, `unknownFormat`, `checksum` or `incomplete` and a readable message.
2. **Catalog:** `runImport` with every guard off (`allowDowngrade`, ratios 1): the downgrade and mass-change/retire guards do not
   apply to curated packs. An identical catalog is a no-op, not an error. The slim catalog has no raw records, so it retires any
   a database holds: the guards of the normal import (`catalog:import`, `singleuser:import <snapshot>`) still block that.
3. **Pictures:** missing ones are written to `<thumbs>/{s,m,l}` through a temp file and a rename; a file that exists stays (same
   name, same content). Then `thumbs.json` is replaced atomically (temp file, rename), then pictures it no longer names are
   deleted (and leftover `.tmp` files).
4. **`data-pack.json`** (the installed manifest) is written atomically, last. `installedPack(dataDir)` reads it (null if there is none or it is unreadable).
5. `maintain()` (CHECKPOINT, VACUUM).

Every step is idempotent: an install interrupted anywhere is repeated, the result is the same. The file work happens outside
the import's transaction (one PGlite connection: the outer `db` must not be used inside it). The result for the UI:
`{ status: 'installed', tag, gameLabel, catalog: 'imported' | 'unchanged', thumbs: { total, written, removed } }` (picture files) or
`{ status: 'appTooOld', tag, packSchemaVersion, appSchemaVersion }`.

**Limits:** ZIP without ZIP64: at most 65,534 entries (three pictures per item, so about 21,800 items) and 4 GiB per entry and
archive; the writer and the reader fail with a clear message beyond that (`src/zip.ts`, which also serves the feature exports).

**Where it lives:** `<data folder>/thumbs/` and `<data folder>/data-pack.json`; the server serves `/thumbs` from `QM_THUMBS_DIR`
if set, else from there. `singleuser:import` always installs into `<data folder>/thumbs`. Tests: `test/datapack.test.ts` (no Postgres).

The pictures are written in a loop that lets the event loop run every 200 files. The catalog import is one stretch of
synchronous work (a few seconds for the real catalog): while it runs, nothing in the process answers, the state endpoint
included.

## Updating the data

`src/datapack/plan.ts` (the plan, pure), `feed.ts` (where releases come from), `updater.ts` (the operations and the state);
`src/singleuser/data-routes.ts` (the endpoints); `main.ts` builds the feed and the updater. Dependencies are passed in: the
updater gets the connection, the folders, the feed, the app's schema version and a log function.

**The feed.** `channels.json` on the repository's `main` branch holds, per product, the stable tag; the data entry is
`"data": { "stable": "<tag>" }` (other entries are ignored). A missing file or entry is "no data channel", not an error. The
repository is the constant `DATA_REPO` in `feed.ts` (`w00zla/quartermaster`). What is fetched, and nothing else:

- `https://raw.githubusercontent.com/<owner>/<repo>/main/channels.json`
- `https://github.com/<owner>/<repo>/releases/download/<tag>/<asset>` for the `manifest.json` of a release and the assets the plan
  needs (the full pack, `catalog.json.gz`, `thumbs-update.zip`)

Tags must be data tags (`parseTag`) and asset names plain file names, else the feed refuses before any request or path is
built. Redirects are followed by `fetch`; one that ends outside GitHub's hosts (`github.com`, `*.githubusercontent.com`) is
refused. Every downloaded file is checked for size and sha256 against its manifest while it streams (more bytes than the manifest
says stop it; a failure deletes the partial file); the intermediate thumbs updates against their own manifests. No signature. A
connection that does not answer in 20 s or stalls for 30 s counts as offline. `QM_DATA_FEED=<dir>` replaces GitHub by a folder
(`<dir>/channels.json`, `<dir>/<tag>/<asset>`) with the same checks.

**The plan** (`planUpdate`): always the feed's newest (no matching to the game version). The same tag as installed: up to
date (no manifest is fetched). The newest manifest's `schemaVersion` is not the app's: `appTooOld` (`pack`: newer or older), nothing
is installed, the app keeps its data. Nothing installed: the full pack. Otherwise the planner walks back from the newest
manifest through `previous` to the installed tag: a **chain** is the newest `catalog.json.gz` and the `thumbs-update.zip` of every
release since the installed one (installed oldest first). It is the **full pack** instead when the walk needs more than 10 steps,
a manifest is missing or is another release's, `previous` is null before the installed tag is reached (this includes an installed
tag that is not in the newest release's history), or catalog size plus the sum of the thumbs updates' sizes is not smaller than the
full pack's size. The import guards do not apply (as for every pack install).

**The state** (`DataUpdateState`, `src/webapp/api-types.ts`), in memory, never read from the database: `phase` (`idle`,
`checking`, `downloading`, `installing`), `installed` (`{ tag, gameLabel }` or null; read from `data-pack.json` at start and
after an install), `progress` (`{ done, total }` bytes while downloading, else null) and `last` (`{ at, outcome }` of the last
finished operation, null since the start): `upToDate`, `noChannel`, `offline` (no network or an error status: nothing changes,
the installed data stays usable), `installed` (+ `tag`), `appTooOld` (+ `tag`, `pack`), `failed` (+ `reason`: `corrupt` = a
checksum or size did not match, `invalid`, `unsupported` = unknown manifest format, `fileMissing`, `internal`; details only in the
log). An aborted run (shutdown) sets no outcome. A failed run installs nothing; its downloads are deleted.

**Operations** (`createDataUpdater`): `check()` (feed, plan, download into `<data>/downloads/`, `installPack` from the parts or the
full pack, clean up) and `importFile(path)` (a full pack the user picked; the path must be an existing file, anything else is what
`installPack` validates). One at a time: a call while one runs returns the running state at once. Both resolve with the final
state and never reject; `stop()` aborts a download and waits for the running operation. A downloads folder left by a crash is removed
when the updater is made.

**Endpoints** (singleuser only, mounted through `WebappConfig.mountApi`; writes are JSON only like the whole API, send `{}`):

| Request | Answer |
|---|---|
| `GET /api/local/data` | the state |
| `POST /api/local/data/check` | starts a check, answers the state at once |
| `POST /api/local/data/import` `{ "path": "<absolute file>" }` | starts the import, answers the state at once; 400 for no or a relative path, 404 `file not found` |

The browser is not told when a catalog changed: the triggers notify user data only (`ServerMessage` has no catalog message), and
the thumbnail index is re-read at most every 10 s.

Tests: `test/datapack-plan.test.ts` (every branch of the plan), `test/datapack-update.test.ts` (feeds with an injected `fetch`, the
updater on a folder feed built with `buildRelease`), the update in `test/singleuser.test.ts` (the real process). None needs the
network or Postgres.

# Identity

The web app's HTTP layer asks an `Identity` who the user of a request is (`src/webapp/identity.ts`; the seam and its
online implementation: `docs/webapp.md` "Identity"). The singleuser one is made with `await localIdentity(db)`
(`src/webapp/identity-local.ts`) and passed to `createApp` and `RealtimeHub`, together with the capabilities
`{ login: 'none', orgs: false, … }`.

- **One fixed user, whatever the database holds:** `LOCAL_USER_ID` = `00000000000000000` (seventeen zeros). User ids
  are Discord snowflakes as text and must match `^[0-9]{17,20}$` (CHECKs in the schema, the same pattern in the code);
  a real snowflake is the decimal form of a number and never starts with a zero, so the id cannot collide with a
  user of an imported database. Name "Local", no avatar. `localIdentity` inserts the `app.app_user` row when it is
  missing (once, when it is made: call it after the migrations, outside a transaction).
- **No login, no sessions, no tokens:** every `/api/*` request and every WebSocket handshake is that user;
  cookies and `Authorization` are not looked at. `/auth/*` and `/api/token` do not exist; the companion release
  files, where configured, need no login either.
- **No orgs:** the schema is there, the org routes (`/api/orgs/…`) are not mounted (`orgs: false`); the fixed user is
  a member of nothing, so every route that takes a guild id refuses through its normal membership check (403
  `notMember`, the stock service's `holderNotMember`).
- `GET /api/capabilities` tells the SPA and the companion what the server is (`login: 'none'`).

## The open API and what still protects it

The local API has no access protection, on purpose: it is a local app, and other programs on the machine may use
the API (the companion does). Two things stay:

- The server binds to `127.0.0.1` (by the process that starts it, not by the identity): nothing off the machine
  reaches it.
- **Web pages cannot write.** Any page open in the user's browser can send requests to `127.0.0.1`. A browser
  always sends `Origin` with a cross-origin write (modern ones `Sec-Fetch-Site` with every request), so
  `acceptsWrite` takes a write when it is same-origin (`Sec-Fetch-Site: same-origin`, else `Origin` = the app's
  origin: the app's own SPA) or carries **neither** `Origin` nor `Sec-Fetch-Site` (not a browser: the companion, a
  script), and refuses every other one (403). `Authorization` earns no exemption here (online it does, for the
  companion's token). Writes take `application/json` only, as online: a cross-origin page cannot send that
  without a CORS preflight, which is never answered. Reads by a page fail in the browser (no CORS headers). The
  WebSocket handshake keeps its check: `Origin` must be the app's origin.

Tests: `test/webapp-local.db.test.ts` (on Postgres and on PGlite).
