// Stores third-party responses in ext.snapshot when their content changed.
import { createHash } from 'node:crypto';
import { and, desc, eq, lt } from 'drizzle-orm';
import type { Db } from '../db/client.ts';
import { snapshot } from '../db/schema/ext.ts';

/**
 * Inserts `data` unless it equals the endpoint's latest snapshot, which then only gets `checked_at`.
 * `latestOnly`: a new snapshot replaces the endpoint's older ones (no history).
 */
export async function storeSnapshot(db: Db, source: string, endpoint: string, data: unknown, latestOnly = false): Promise<'inserted' | 'unchanged'> {
  const contentHash = createHash('sha256').update(JSON.stringify(data)).digest('hex');
  return db.transaction(async (tx) => {
    const [latest] = await tx.select({ id: snapshot.id, contentHash: snapshot.contentHash }).from(snapshot)
      .where(and(eq(snapshot.source, source), eq(snapshot.endpoint, endpoint))).orderBy(desc(snapshot.id)).limit(1).for('update');
    if (latest?.contentHash === contentHash) {
      await tx.update(snapshot).set({ checkedAt: new Date() }).where(eq(snapshot.id, latest.id));
      return 'unchanged';
    }
    const [row] = await tx.insert(snapshot).values({ source, endpoint, contentHash, data }).returning({ id: snapshot.id });
    if (latestOnly) await tx.delete(snapshot).where(and(eq(snapshot.source, source), eq(snapshot.endpoint, endpoint), lt(snapshot.id, row!.id)));
    return 'inserted';
  });
}
