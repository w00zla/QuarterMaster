import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as catalog from './schema/catalog.ts';

export const schema = { ...catalog };
export type Db = PostgresJsDatabase<typeof schema>;
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

export function connect(url: string | undefined): { db: Db; close: () => Promise<void> } {
  if (!url) throw new Error('DATABASE_URL is not set');
  // JIT off for our sessions: compiling short queries costs far more than it saves
  // (the item list: ~450 ms of JIT for a ~35 ms query)
  const client = postgres(url, { onnotice: () => {}, connection: { jit: 'off' } });
  return { db: drizzle(client, { schema }), close: () => client.end() };
}
