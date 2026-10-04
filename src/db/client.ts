import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as catalog from './schema/catalog.ts';

export const schema = { ...catalog };
export type Db = PostgresJsDatabase<typeof schema>;
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

export function connect(url: string | undefined): { db: Db; close: () => Promise<void> } {
  if (!url) throw new Error('DATABASE_URL is not set');
  const client = postgres(url, { onnotice: () => {} });
  return { db: drizzle(client, { schema }), close: () => client.end() };
}
