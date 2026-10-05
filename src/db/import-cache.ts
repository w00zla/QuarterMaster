// In-memory cache for data derived from the catalog (labels, pickers), one value per language.
// Reloaded once a newer catalog import exists; that is checked at most once a minute.
import { sql } from 'drizzle-orm';
import type { Db } from './client.ts';
import { one } from './query.ts';

const CHECK_IMPORT_MS = 60_000;

export function importCache<T, L extends string = string>(load: (db: Db, lang: L) => Promise<T>) {
  const caches = new Map<L, { importId: number | null; checkedAt: number; value: T }>();
  return async (db: Db, lang: L): Promise<T> => {
    const cached = caches.get(lang);
    if (cached && Date.now() - cached.checkedAt < CHECK_IMPORT_MS) return cached.value;
    const latest = (await one<{ id: number | null }>(db, sql`SELECT max(id) AS id FROM catalog.import`))?.id ?? null;
    if (cached && cached.importId === latest) {
      cached.checkedAt = Date.now();
      return cached.value;
    }
    const value = await load(db, lang);
    caches.set(lang, { importId: latest, checkedAt: Date.now(), value });
    return value;
  };
}
