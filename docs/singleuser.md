# Singleuser variant: the database

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
