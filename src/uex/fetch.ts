// Pulls UEX API endpoints and stores each response in uex.snapshot when its content changed.
import { createHash } from 'node:crypto';
import { desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '../db/client.ts';
import { snapshot } from '../db/schema/uex.ts';

export const UEX_API = 'https://api.uexcorp.uk/2.0';
export const UEX_ENDPOINTS = ['refineries_yields', 'refineries_methods'] as const;

const Response = z.object({ status: z.literal('ok'), data: z.array(z.record(z.string(), z.unknown())) });

/** GET one endpoint; returns its `data` array. Throws on HTTP errors and unexpected shapes. */
export async function fetchEndpoint(endpoint: string, token: string, fetchFn: typeof fetch = fetch): Promise<unknown[]> {
  const res = await fetchFn(`${UEX_API}/${endpoint}/`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`UEX ${endpoint}: HTTP ${res.status} ${text.slice(0, 200)}`);
  const parsed = Response.safeParse(JSON.parse(text));
  if (!parsed.success) throw new Error(`UEX ${endpoint}: unexpected response ${text.slice(0, 200)}`);
  return parsed.data.data;
}

/** Inserts `data` unless it equals the endpoint's latest snapshot, which then only gets `checked_at`. */
export async function storeSnapshot(db: Db, endpoint: string, data: unknown[]): Promise<'inserted' | 'unchanged'> {
  const contentHash = createHash('sha256').update(JSON.stringify(data)).digest('hex');
  return db.transaction(async (tx) => {
    const [latest] = await tx.select({ id: snapshot.id, contentHash: snapshot.contentHash }).from(snapshot)
      .where(eq(snapshot.endpoint, endpoint)).orderBy(desc(snapshot.id)).limit(1).for('update');
    if (latest?.contentHash === contentHash) {
      await tx.update(snapshot).set({ checkedAt: new Date() }).where(eq(snapshot.id, latest.id));
      return 'unchanged';
    }
    await tx.insert(snapshot).values({ endpoint, contentHash, data });
    return 'inserted';
  });
}

/** Fetches and stores every endpoint; one failing endpoint does not stop the others. */
export async function pullAll(db: Db, token: string, fetchFn: typeof fetch = fetch): Promise<void> {
  for (const endpoint of UEX_ENDPOINTS) {
    try {
      const data = await fetchEndpoint(endpoint, token, fetchFn);
      const result = await storeSnapshot(db, endpoint, data);
      console.log(`UEX ${endpoint}: ${data.length} rows, ${result}`);
    } catch (err) {
      console.error(`UEX ${endpoint} failed`, err);
    }
  }
}
