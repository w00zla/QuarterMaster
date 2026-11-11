// The player's language pack as a localization source (docs/singleuser.md "The language pack"): stored once under `en`
// with a priority above the game's texts and below the app's own, synced against the file at every start.
//
// Why `en`: `locText` (src/db/query.ts) asks the effective texts of the requested language first and those of `en`
// second. The singleuser snapshot holds English game texts only, so a `de` lookup finds nothing under `de` (except
// the app's own `qm_` texts, which the pack never holds) and falls back to the effective `en` text: the pack's where
// it has the key, the game's English where it lacks it. Both UI languages see the same game texts, and no query knows
// about this source.
import { sql } from 'drizzle-orm';
import type { Db } from '../db/client.ts';
import { IMPORT_LOCK } from '../catalog/import/apply.ts';
import { PACK_PRIORITY, PACK_SOURCE, readSources, readTexts, removeSource, writeTexts } from '../catalog/import/localization.ts';
import { diffTexts, textsSha256 } from '../catalog/import/plan.ts';
import type { LanguagePack } from './game-folder.ts';

const LANG = 'en';

export type PackSync =
  | { outcome: 'none' }
  | { outcome: 'unchanged'; texts: number }
  | { outcome: 'written'; texts: number; added: number; changed: number; removed: number }
  | { outcome: 'removed'; texts: number };

/**
 * Makes the stored source match the pack (one transaction, only the transaction object inside): the same content hash
 * writes nothing; a different or new pack writes only the added and changed texts and deletes the vanished ones; no
 * usable pack removes the source. `maintain` runs only when rows were written or removed. None of `loc:import`'s guards
 * apply: the player's own file is taken as it is.
 */
export async function syncLanguagePack(
  connection: { db: Db; maintain: () => Promise<void> },
  pack: LanguagePack | null,
  log: (message: string) => void = () => {},
): Promise<PackSync> {
  const started = performance.now();
  const texts = pack?.texts ? Object.fromEntries(pack.texts) : null;
  const sha = texts ? textsSha256(texts) : null;
  const result = await connection.db.transaction(async (tx): Promise<PackSync> => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${IMPORT_LOCK})`);
    const [previous] = await readSources(tx, { source: PACK_SOURCE, lang: LANG });
    if (texts === null || sha === null) {
      if (!previous) return { outcome: 'none' };
      await removeSource(tx, PACK_SOURCE, LANG);
      return { outcome: 'removed', texts: previous.keyCount };
    }
    const total = Object.keys(texts).length;
    if (previous && previous.contentSha256 === sha) return { outcome: 'unchanged', texts: total };
    const diff = diffTexts(texts, await readTexts(tx, PACK_SOURCE, LANG));
    await writeTexts(tx, { source: PACK_SOURCE, lang: LANG, priority: PACK_PRIORITY, origin: pack!.file!, contentSha256: sha, diff });
    return { outcome: 'written', texts: total, added: diff.added.length, changed: diff.changed.length, removed: diff.removed.length };
  });
  if (result.outcome === 'written' || result.outcome === 'removed') await connection.maintain();
  const ms = Math.round(performance.now() - started);
  log(result.outcome === 'written'
    ? `language pack sync: written, ${result.texts} texts (${result.added} added, ${result.changed} changed, ${result.removed} removed) (${ms} ms)`
    : `language pack sync: ${result.outcome}${'texts' in result ? `, ${result.texts} texts` : ''} (${ms} ms)`);
  return result;
}
