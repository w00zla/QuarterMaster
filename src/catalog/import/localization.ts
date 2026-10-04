// Localization text sets per source and language, shared by the catalog import ('game')
// and the import of externally maintained global.ini files.
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { Tx } from '../../db/client.ts';
import * as c from '../../db/schema/catalog.ts';
import { chunks, type TextDiff } from './plan.ts';

export const GAME_SOURCE = 'game';
export const GAME_PRIORITY = 0;
// Texts the app defines itself (keys with APP_KEY_PREFIX), maintained via the admin UI
export const APP_SOURCE = 'app';
export const APP_PRIORITY = 1000;
export const DEFAULT_EXTERNAL_PRIORITY = 100;

export type SourceRow = typeof c.localizationSource.$inferSelect;

export async function readTexts(tx: Tx, source: string, lang: string): Promise<Map<string, string>> {
  const rows = await tx.select({ key: c.localization.key, value: c.localization.value }).from(c.localization)
    .where(and(eq(c.localization.source, source), eq(c.localization.lang, lang)));
  return new Map(rows.map((r) => [r.key, r.value]));
}

export async function readKeys(tx: Tx, source: string, lang: string): Promise<Set<string>> {
  const rows = await tx.select({ key: c.localization.key }).from(c.localization)
    .where(and(eq(c.localization.source, source), eq(c.localization.lang, lang)));
  return new Set(rows.map((r) => r.key));
}

export async function readSources(tx: Tx, filter: { source?: string; lang?: string } = {}): Promise<SourceRow[]> {
  const conditions = [
    filter.source !== undefined ? eq(c.localizationSource.source, filter.source) : undefined,
    filter.lang !== undefined ? eq(c.localizationSource.lang, filter.lang) : undefined,
  ].filter((x) => x !== undefined);
  return tx.select().from(c.localizationSource).where(conditions.length ? and(...conditions) : undefined)
    .orderBy(c.localizationSource.lang, sql`${c.localizationSource.priority} DESC`, c.localizationSource.source);
}

/** Writes a text set according to its diff and records the source with its priority. */
export async function writeTexts(tx: Tx, input: {
  source: string; lang: string; priority: number; origin: string; contentSha256: string; diff: TextDiff;
}) {
  const { source, lang, diff } = input;
  await tx.insert(c.localizationSource).values({
    source, lang, priority: input.priority, origin: input.origin, contentSha256: input.contentSha256, keyCount: diff.total,
  }).onConflictDoUpdate({
    target: [c.localizationSource.source, c.localizationSource.lang],
    set: {
      priority: input.priority, origin: input.origin, contentSha256: input.contentSha256, keyCount: diff.total, importedAt: sql`now()`,
    },
  });
  for (const batch of chunks(diff.removed, 5000)) {
    await tx.delete(c.localization).where(and(
      eq(c.localization.source, source), eq(c.localization.lang, lang), inArray(c.localization.key, batch)));
  }
  for (const batch of chunks([...diff.added, ...diff.changed], 5000)) {
    await tx.insert(c.localization).values(batch.map(([key, value]) => ({ source, lang, key, value })))
      .onConflictDoUpdate({
        target: [c.localization.source, c.localization.lang, c.localization.key],
        set: { value: sql.raw('excluded."value"') },
      });
  }
}

/** Deletes a source for one language; its texts go with it (cascade). */
export async function removeSource(tx: Tx, source: string, lang: string): Promise<void> {
  await tx.delete(c.localizationSource).where(and(eq(c.localizationSource.source, source), eq(c.localizationSource.lang, lang)));
}

/** Number of keys for which the source currently provides the effective text. */
export async function countWins(tx: Tx, source: string, lang: string): Promise<number> {
  const [row] = await tx.select({ n: sql<string>`count(*)::text` }).from(c.localizationEffective)
    .where(and(eq(c.localizationEffective.lang, lang), eq(c.localizationEffective.source, source)));
  return Number(row?.n ?? 0);
}
