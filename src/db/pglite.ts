// The database in the process: PGlite (Postgres as WASM, data in a folder or in memory) behind the same
// shape the rest of the code gets from connect(). Only the singleuser variant and the tests import this file;
// the online entry points use connect() and never load PGlite.
import { AsyncLocalStorage } from 'node:async_hooks';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate as drizzleMigrate } from 'drizzle-orm/pglite/migrator';
import { schema, type ChangeSource, type Db } from './client.ts';

/**
 * Server settings, passed as the constructor's `postgresqlconf`. Measured: ~105 MB of memory instead of ~260,
 * and the WAL stays bounded (it recycles at 32 MB; without a limit it grows into the hundreds of MB during imports).
 * They are written into the data dir at every open. In-memory instances ignore them (PGlite 0.5.15 starts those
 * with its stock configuration), which does not matter for a database that lives as long as one test process.
 */
export const PGLITE_DEFAULT_CONF = ['max_wal_size=32MB', 'min_wal_size=32MB', 'shared_buffers=16MB'];

export type PgliteOptions = {
  /** `name=value` settings; they replace the default of the same name, the other defaults stay. */
  postgresqlconf?: string[];
};

export type PgliteConnection = {
  /** The drizzle database. `execute()` returns the rows (as postgres.js does), also inside transactions. */
  db: Db;
  /** For LISTEN (see ChangeSource). */
  client: ChangeSource;
  /** Applies the migrations of the folder. */
  migrate: (migrationsFolder: string) => Promise<void>;
  /** CHECKPOINT, then VACUUM: PGlite does neither by itself. Call it after big writes, never inside a transaction. */
  maintain: () => Promise<void>;
  /** Releases this connection; the last one of a data dir closes PGlite (see connectPglite). Calling it twice is fine. */
  close: () => Promise<void>;
};

type Instance = { lite: PGlite; users: number };
// One PGlite per data dir and process: a second one on the same files would corrupt them. In memory there is one
// per process as well (the key MEMORY), so several connections see the same database, as long as one stays open.
const MEMORY = ':memory:';
const instances = new Map<string, Instance>();

const confName = (setting: string) => setting.split('=')[0]!.trim();

/**
 * Opens PGlite on `dataDir` (null/undefined = in memory) and returns a connection to it.
 * Connections to the same data dir share one instance; `close()` closes PGlite when the last of them is closed
 * (await it before opening the dir again). Closing matters: after a CHECKPOINT or VACUUM an instance that is not closed
 * keeps the process alive for ~10 s. In memory the data is gone with the last connection.
 * `options` apply when the instance is created.
 */
export function connectPglite(dataDir?: string | null, options: PgliteOptions = {}): PgliteConnection {
  const key = dataDir ?? MEMORY;
  let instance = instances.get(key);
  if (!instance) {
    const own = new Set((options.postgresqlconf ?? []).map(confName));
    const conf = [...PGLITE_DEFAULT_CONF.filter((s) => !own.has(confName(s))), ...(options.postgresqlconf ?? [])];
    instance = { lite: new PGlite(dataDir ?? undefined, { postgresqlconf: conf }), users: 0 };
    instances.set(key, instance);
  }
  instance.users++;
  const { lite } = instance;
  const raw = drizzle(lite, { schema });
  let closed = false;
  return {
    db: rowsOnly(raw, true) as unknown as Db,
    client: {
      listen: async (channel, onNotify, onListen) => {
        const unlisten = await lite.listen(channel, onNotify);
        // postgres.js calls this at every (re)connect; PGlite has one connection that never drops: once
        onListen?.();
        return { unlisten };
      },
    },
    migrate: (migrationsFolder) => drizzleMigrate(raw, { migrationsFolder }),
    maintain: async () => {
      // Separate calls: VACUUM does not run in the implicit transaction of a multi-statement exec
      await lite.exec('CHECKPOINT');
      await lite.exec('VACUUM');
    },
    close: async () => {
      if (closed) return;
      closed = true;
      if (--instance.users > 0) return;
      instances.delete(key);
      await lite.close();
    },
  };
}

// --- rows adapter and guard ---

// Set while a transaction callback runs (and in everything it starts)
const inTransaction = new AsyncLocalStorage<boolean>();
// Everything on the outer db that needs the connection
const QUERY_METHODS = new Set([
  'execute', 'select', 'selectDistinct', 'selectDistinctOn', 'insert', 'update', 'delete', 'transaction', '$count', 'with', 'query',
]);

/**
 * postgres.js hands execute() the rows, drizzle's PGlite driver a result object: the code base uses the rows,
 * on the db and on transactions, so this is the one place that unwraps them.
 *
 * `outer`: PGlite has ONE connection. The outer db used while a transaction is open waits for that transaction
 * forever (a deadlock that looks like a hang); here it fails at once, naming the method. Online (postgres.js)
 * the same code just runs on another connection, so this guard exists on the PGlite side only.
 */
function rowsOnly<T extends object>(db: T, outer = false): T {
  return new Proxy(db, {
    get(target, prop, receiver) {
      if (outer && inTransaction.getStore() && QUERY_METHODS.has(prop as string)) {
        throw new Error(`db.${String(prop)}() was called inside a transaction: PGlite has one connection, use the transaction object (tx) instead`);
      }
      if (prop === 'execute') {
        return async (...args: unknown[]) => ((await (target as any).execute(...args)) as { rows: unknown[] }).rows;
      }
      if (prop === 'transaction') {
        return (fn: (tx: unknown) => unknown, config?: unknown) =>
          (target as any).transaction((tx: object) => inTransaction.run(true, () => fn(rowsOnly(tx))), config);
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

