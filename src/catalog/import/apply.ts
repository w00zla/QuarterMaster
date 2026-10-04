// Database side of the catalog import: one transaction, advisory-locked, dry-run = rollback.
import { and, eq, getTableColumns, inArray, isNull, ne, sql, TransactionRollbackError } from 'drizzle-orm';
import type { Db } from '../../db/client.ts';
import * as c from '../../db/schema/catalog.ts';
import type { Snapshot } from '../snapshot.ts';
import { GAME_PRIORITY, GAME_SOURCE, readSources, readTexts, removeSource, writeTexts } from './localization.ts';
import {
  ENTITY_NAMES, blueprintChildren, chunks, diffEntities, diffTexts, evaluateSafeguards, textsSha256, toEntitySets,
  type EntityDiff, type EntityName, type ExistingRow, type LastImport, type SafeguardOptions, type SafeguardResult, type TextDiff,
} from './plan.ts';

// Serializes catalog and localization imports
export const IMPORT_LOCK = 7_420_001;

const TABLES = {
  manufacturer: c.manufacturer,
  item: c.item,
  resource: c.resource,
  blueprintCategory: c.blueprintCategory,
  craftedProperty: c.craftedProperty,
  qualityQuantization: c.qualityQuantization,
  blueprint: c.blueprint,
  location: c.location,
  rawRecord: c.rawRecord,
};

// All entity tables share the lifecycle columns; this view of them keeps the generic code typed
type EntityTable = typeof c.blueprintCategory;
const entityTable = (name: EntityName) => TABLES[name] as unknown as EntityTable;

// Rows per statement; raw records carry large JSON documents
const BATCH: Partial<Record<EntityName, number>> = { rawRecord: 100 };
const DEFAULT_BATCH = 500;

export interface ImportOptions extends SafeguardOptions {
  dryRun: boolean;
}

export interface ImportResult {
  status: 'imported' | 'dry-run' | 'noop' | 'blocked';
  importId: number | null;
  last: LastImport | null;
  diffs: Record<EntityName, EntityDiff>;
  // Game texts per language
  localization: Record<string, TextDiff>;
  safeguards: SafeguardResult;
  timings: Record<string, number>;
}

/** `SET col = excluded.col` for every column except the given ones. */
function excludedSet(table: Parameters<typeof getTableColumns>[0], skip: string[]) {
  return Object.fromEntries(Object.entries(getTableColumns(table))
    .filter(([key]) => !skip.includes(key))
    .map(([key, col]) => [key, sql.raw(`excluded."${col.name}"`)]));
}

export async function runImport(db: Db, snapshot: Snapshot, snapshotSha256: string, options: ImportOptions): Promise<ImportResult> {
  const timings: Record<string, number> = {};
  const timed = async <T>(label: string, fn: () => Promise<T>): Promise<T> => {
    const t0 = performance.now();
    try {
      return await fn();
    } finally {
      timings[label] = (timings[label] ?? 0) + performance.now() - t0;
    }
  };

  const sets = toEntitySets(snapshot);
  let result: ImportResult | undefined;

  try {
    await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${IMPORT_LOCK})`);

      // --- read current state and diff ---
      const { last, diffs, locDiff } = await timed('read+diff', async () => {
        const [lastRow] = await tx.select({
          id: c.importRun.id, channel: c.importRun.channel, gameBuild: c.importRun.gameBuild, snapshotSha256: c.importRun.snapshotSha256,
        }).from(c.importRun).orderBy(sql`${c.importRun.id} DESC`).limit(1);
        const diffs = {} as Record<EntityName, EntityDiff>;
        for (const name of ENTITY_NAMES) {
          const t = entityTable(name);
          const rows = await tx.select({ uuid: t.uuid, contentHash: t.contentHash, retiredAt: t.retiredAt }).from(t);
          const existing = new Map<string, ExistingRow>(rows.map((r) => [r.uuid, { contentHash: r.contentHash, retired: r.retiredAt !== null }]));
          diffs[name] = diffEntities(sets[name], existing);
        }
        // Game texts per language; languages the game no longer ships are removed
        const locDiff: Record<string, TextDiff> = {};
        for (const [lang, texts] of Object.entries(snapshot.localization)) {
          locDiff[lang] = diffTexts(texts, await readTexts(tx, GAME_SOURCE, lang));
        }
        for (const { lang } of await readSources(tx, { source: GAME_SOURCE })) {
          if (!locDiff[lang]) locDiff[lang] = diffTexts({}, await readTexts(tx, GAME_SOURCE, lang));
        }
        return { last: lastRow ?? null, diffs, locDiff };
      });

      const safeguards = evaluateSafeguards({ game: snapshot.game, sha256: snapshotSha256, last, diffs, options });
      result = { status: 'imported', importId: null, last, diffs, localization: locDiff, safeguards, timings };
      if (safeguards.noop || safeguards.violations.length > 0) {
        result.status = safeguards.noop ? 'noop' : 'blocked';
        tx.rollback();
      }

      // --- write ---
      await timed('write', async () => {
        const [run] = await tx.insert(c.importRun).values({
          channel: snapshot.game.channel,
          gameBuild: snapshot.game.build,
          gameBranch: snapshot.game.branch,
          gameVersion: snapshot.game.version,
          gameLabel: snapshot.game.label,
          manifest: snapshot.game.manifest,
          schemaVersion: snapshot.schemaVersion,
          snapshotSha256,
          extractorVersion: snapshot.extractor.version,
          starbreakerVersion: snapshot.extractor.starbreaker,
          extractedAt: new Date(snapshot.extractedAt),
          forced: options.force,
          anomalies: snapshot.anomalies,
        }).returning({ id: c.importRun.id });
        const importId = run!.id;
        result!.importId = importId;

        for (const name of ENTITY_NAMES) {
          const t = entityTable(name);
          const d = diffs[name];
          const write = new Set([...d.added, ...d.changed, ...d.revived]);
          const rows = sets[name].filter((r) => write.has(r.uuid))
            .map((r) => ({ ...r, firstSeenImportId: importId, lastSeenImportId: importId, retiredAt: null }));
          for (const batch of chunks(rows, BATCH[name] ?? DEFAULT_BATCH)) {
            await tx.insert(t).values(batch as never[])
              .onConflictDoUpdate({ target: t.uuid, set: excludedSet(t, ['uuid', 'firstSeenImportId']) });
          }
          for (const batch of chunks(d.unchanged, 5000)) {
            await tx.update(t).set({ lastSeenImportId: importId }).where(inArray(t.uuid, batch));
          }
          if (name === 'blueprint') await replaceRecipes(tx, snapshot, [...write]);
        }

        // Everything not seen in this import gets retired; must match the diff exactly
        for (const name of ENTITY_NAMES) {
          const t = entityTable(name);
          const retired = await tx.update(t).set({ retiredAt: sql`now()` })
            .where(and(isNull(t.retiredAt), ne(t.lastSeenImportId, importId))).returning({ uuid: t.uuid });
          if (retired.length !== diffs[name].retired.length) {
            throw new Error(`${name}: retired ${retired.length} rows, diff expected ${diffs[name].retired.length}`);
          }
        }

        const origin = `snapshot ${snapshot.game.channel} ${snapshot.game.build}`;
        for (const [lang, diff] of Object.entries(locDiff)) {
          const texts = snapshot.localization[lang];
          if (texts) {
            await writeTexts(tx, { source: GAME_SOURCE, lang, priority: GAME_PRIORITY, origin, contentSha256: textsSha256(texts), diff });
          } else {
            await removeSource(tx, GAME_SOURCE, lang);
          }
        }

        await tx.update(c.importRun).set({ summary: summarize(result!) }).where(eq(c.importRun.id, importId));
      });

      if (options.dryRun) {
        result!.status = 'dry-run';
        tx.rollback();
      }
    });
  } catch (err) {
    if (!(err instanceof TransactionRollbackError)) throw err;
  }
  return result!;
}

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

/** Replaces tiers, slots and inputs of the given blueprints. */
async function replaceRecipes(tx: Tx, snapshot: Snapshot, uuids: string[]) {
  const wanted = new Set(uuids);
  const children = blueprintChildren(snapshot.blueprints.filter((b) => wanted.has(b.uuid)));
  for (const batch of chunks(uuids, 5000)) {
    await tx.delete(c.blueprintInput).where(inArray(c.blueprintInput.blueprintUuid, batch));
    await tx.delete(c.blueprintSlot).where(inArray(c.blueprintSlot.blueprintUuid, batch));
    await tx.delete(c.blueprintTier).where(inArray(c.blueprintTier.blueprintUuid, batch));
  }
  for (const batch of chunks(children.tiers, 2000)) await tx.insert(c.blueprintTier).values(batch);
  for (const batch of chunks(children.slots, 2000)) await tx.insert(c.blueprintSlot).values(batch);
  for (const batch of chunks(children.inputs, 2000)) await tx.insert(c.blueprintInput).values(batch);
}

/** Counts only; stored with the import run and printed by the CLI. */
export function summarize(r: ImportResult) {
  const entities = Object.fromEntries(ENTITY_NAMES.map((name) => {
    const d = r.diffs[name];
    return [name, {
      total: d.total, added: d.added.length, changed: d.changed.length, unchanged: d.unchanged.length,
      revived: d.revived.length, retired: d.retired.length,
    }];
  }));
  const localization = Object.fromEntries(Object.entries(r.localization).map(([lang, d]) => [lang, textDiffCounts(d)]));
  return {
    entities,
    localization,
    warnings: r.safeguards.warnings,
    timingsMs: Object.fromEntries(Object.entries(r.timings).map(([k, v]) => [k, Math.round(v)])),
  };
}

export function textDiffCounts(d: TextDiff) {
  return { total: d.total, added: d.added.length, changed: d.changed.length, unchanged: d.unchanged, removed: d.removed.length };
}
