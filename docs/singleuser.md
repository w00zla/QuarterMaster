# Singleuser variant

Three parts are described here: the process (how it starts and what it keeps), the database (PGlite) and who the user
is (the local identity).

# The process

`src/singleuser/main.ts` is the variant's composition root: one local process that serves the web app (the built SPA,
`webapp/dist`) and its API on PGlite for the one fixed user.

```sh
pnpm singleuser                                   # the server
pnpm singleuser:import <snapshot.json.gz> [opts]  # the catalog import into the same data folder (catalog:import's options)
```

The SPA must be built (`pnpm webapp:build`). **One process per data folder:** PGlite has no second opener, so the server
and `singleuser:import` must not run at the same time on one folder (use `QM_DATA_DIR` for a second folder).
`singleuser:import` migrates a fresh folder first, imports, then runs `maintain()` (CHECKPOINT and VACUUM).

| Variable | Meaning |
|---|---|
| `QM_DATA_DIR` | the data folder; else `%LOCALAPPDATA%QuarterMastersingleuser` (Windows) or `${XDG_DATA_HOME:-~/.local/share}/quartermaster/singleuser`; created if missing |
| `QM_PORT` | exactly this port, or the start fails; else the first free one of 28460-28469 (tried by listening on 127.0.0.1) |
| `QM_THUMBS_DIR` | the thumbnails folder (`s/`, `m/`, `l/`, `thumbs.json`); else `<data folder>/thumbs`, which may be missing (no thumbnails then) |

(`src/singleuser/paths.ts`, `port.ts`: pure, passed the environment; tested in `test/singleuser-helpers.test.ts`.)

**Data folder:** `db/` (the PGlite database, with its `pg_wal/`) and, if the user puts them there, `thumbs/`. Nothing else.

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

**What the variant does not have:** orgs (no org routes, no membership), login and sessions, API tokens, the Discord bot,
the admin UI, the UEX pull.

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
