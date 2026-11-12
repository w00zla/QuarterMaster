// One entry for the CLIs and the tests that run on both engines: `pglite:memory` or `pglite:<data dir>` opens
// PGlite in the process, anything else is a Postgres URL for postgres.js. The online entry points do not use this:
// they call connect() and never load PGlite.
import { migrate as migratePostgres } from 'drizzle-orm/postgres-js/migrator';
import { connect, type ChangeSource, type Db } from './client.ts';
import { connectPglite } from './pglite.ts';

export type Connection = {
  db: Db;
  client: ChangeSource;
  migrate: (migrationsFolder: string) => Promise<void>;
  /** CHECKPOINT and VACUUM on PGlite (which does neither by itself); nothing on Postgres, which has autovacuum. */
  maintain: () => Promise<void>;
  close: () => Promise<void>;
};

export const isPgliteUrl = (url: string | undefined) => url?.startsWith('pglite:') ?? false;

export function connectUrl(url: string | undefined): Connection {
  if (isPgliteUrl(url)) {
    const dir = url!.slice('pglite:'.length);
    if (!dir) throw new Error('pglite: URL needs "memory" or a data directory');
    return connectPglite(dir === 'memory' ? null : dir);
  }
  const { db, close, client } = connect(url);
  return { db, client, close, maintain: async () => {}, migrate: (migrationsFolder) => migratePostgres(db, { migrationsFolder }) };
}
