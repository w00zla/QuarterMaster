// Read side for stock pickers and displays: selectable locations and bookable materials (cached in
// memory per language, reloaded after a newer catalog import) and the batches an actor may change.
// No Discord here: the bot and the web UI build their own labels from these.
import { sql } from 'drizzle-orm';
import type { Db } from '../db/client.ts';
import { importCache } from '../db/import-cache.ts';
import { locText, rows } from '../db/query.ts';
import type { SubjectKind } from './amount.ts';
import { selectableLocationSql, type Actor, type Batch } from './service.ts';

export interface LocationEntry {
  uuid: string;
  name: string;
  nameEn: string;
  // Nearest planet or moon above it, if any
  body: string | null;
  system: string | null;
  // "Area18 · ArcCorp · Stanton"
  label: string;
  // The name, plus the system where the name alone is ambiguous (gateways exist in two systems)
  short: string;
}

export const locationCatalog = importCache(async (db, lang): Promise<Map<string, LocationEntry>> => {
  // The whole star map is small (~2k rows): walk the parents in memory
  const all = await rows<{ uuid: string; parent: string | null; nav: string | null; name: string | null; nameEn: string | null; selectable: boolean }>(db, sql`
    SELECT l.uuid, l.parent_uuid AS parent, l.nav_icon AS nav, ${locText(lang, sql`l.name_key`)} AS name,
      ${locText('en', sql`l.name_key`)} AS "nameEn", (${selectableLocationSql()} AND l.retired_at IS NULL) AS selectable
    FROM catalog.location l`);
  const byUuid = new Map(all.map((l) => [l.uuid, l]));
  const ancestors = (uuid: string) => {
    const chain = [];
    for (let p = byUuid.get(uuid)?.parent; p && chain.length < 10; p = byUuid.get(p)?.parent) {
      const node = byUuid.get(p);
      if (node) chain.push(node);
    }
    return chain;
  };
  const entries = all.filter((l) => l.selectable).map((l) => {
    const chain = ancestors(l.uuid);
    const body = chain.find((a) => a.nav === 'Planet' || a.nav === 'Moon')?.name ?? null;
    const system = chain.find((a) => a.nav === 'Star')?.name ?? null;
    const name = l.name ?? l.nameEn!;
    return { uuid: l.uuid, name, nameEn: l.nameEn!, body, system, label: [name, body, system].filter(Boolean).join(' · '), short: name };
  });
  const counts = new Map<string, number>();
  for (const e of entries) counts.set(e.name, (counts.get(e.name) ?? 0) + 1);
  for (const e of entries) if (counts.get(e.name)! > 1 && e.system) e.short = `${e.name} · ${e.system}`;
  return new Map(entries.map((e) => [e.uuid, e]));
});

export interface MaterialEntry {
  kind: SubjectKind;
  uuid: string;
  name: string;
  nameEn: string;
  isOre: boolean;
}

/** What can be booked: recipe resources, their ores, recipe items (same rules as the stock service). */
export const materialCatalog = importCache(async (db, lang): Promise<Map<string, MaterialEntry>> => {
  const found = await rows<MaterialEntry>(db, sql`
    SELECT 'resource' AS kind, r.uuid, coalesce(${locText(lang, sql`r.name_key`)}, r.key) AS name,
      coalesce(${locText('en', sql`r.name_key`)}, r.key) AS "nameEn", r.is_ore AS "isOre"
    FROM catalog.resource r
    WHERE r.retired_at IS NULL AND EXISTS (SELECT 1 FROM catalog.blueprint_input bi
      WHERE bi.resource_uuid = CASE WHEN r.is_ore THEN r.refined_uuid ELSE r.uuid END)
    UNION ALL
    SELECT 'item', i.uuid, coalesce(${locText(lang, sql`i.name_key`)}, i.class_name),
      coalesce(${locText('en', sql`i.name_key`)}, i.class_name), false
    FROM catalog.item i
    WHERE i.retired_at IS NULL AND EXISTS (SELECT 1 FROM catalog.blueprint_input bi WHERE bi.item_uuid = i.uuid)`);
  return new Map(found.map((m) => [m.uuid, m]));
});

/** Entries whose text contains every word of the query; first word at the start of `name` first, then alphabetical. */
export function searchWords<T>(entries: Iterable<T>, query: string, text: (e: T) => string, name: (e: T) => string, limit = 25): T[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const first = words[0] ?? '';
  const found: [number, string, T][] = [];
  for (const e of entries) {
    const hay = text(e).toLowerCase();
    if (words.every((w) => hay.includes(w))) found.push([name(e).toLowerCase().startsWith(first) ? 0 : 1, name(e), e]);
  }
  return found.sort((a, b) => a[0] - b[0] || a[1].localeCompare(b[1])).slice(0, limit).map(([, , e]) => e);
}

/** remove/adjust: any batch the actor may change; move: not refinery jobs; refining: the actor's own refinery jobs. */
export type BatchPick = 'change' | 'move' | 'refining';

export interface PickableBatch {
  batch: Batch;
  material: string;
  location: string;
  // Org stock: who holds it
  holderName: string | null;
}

/**
 * Batches the actor may change: their personal stock and, for officers, the org's stock.
 * Ordered by material name, then quality (best first).
 */
export async function pickableBatches(db: Db, actor: Actor, pick: BatchPick, lang: string): Promise<PickableBatch[]> {
  const scope = pick === 'refining' || !actor.officer || !actor.guildId
    ? sql`b.guild_id IS NULL AND b.owner_user_id = ${actor.userId}`
    : sql`((b.guild_id IS NULL AND b.owner_user_id = ${actor.userId}) OR b.guild_id = ${actor.guildId})`;
  const state = pick === 'refining' ? sql`b.state = 'refining'` : pick === 'move' ? sql`b.state = 'stored'` : sql`true`;
  const found = await rows<Batch & { holderName: string | null }>(db, sql`
    SELECT b.id::int AS id, b.guild_id AS "guildId", b.owner_user_id AS "ownerUserId", b.designation, b.kind,
      b.resource_uuid AS "resourceUuid", b.item_uuid AS "itemUuid", b.location_uuid AS "locationUuid", b.state, b.quality,
      b.quantity::text AS quantity, m.display_name AS "holderName"
    FROM app.stock_batch b
    LEFT JOIN app.member m ON b.guild_id IS NOT NULL AND m.guild_id = b.guild_id AND m.user_id = b.owner_user_id
    WHERE ${scope} AND ${state}`);
  const [materials, locations] = [await materialCatalog(db, lang), await locationCatalog(db, lang)];
  // Batches may reference retired catalog entries, which the caches leave out: fall back to the names stored in the catalog
  const fallbackNames = await missingNames(db, lang, found.filter((b) => !materials.has(b.resourceUuid ?? b.itemUuid!)).map((b) => b.resourceUuid ?? b.itemUuid!),
    found.filter((b) => !locations.has(b.locationUuid)).map((b) => b.locationUuid));
  return found
    .map(({ holderName, ...batch }) => {
      const subject = batch.resourceUuid ?? batch.itemUuid!;
      return {
        batch,
        material: materials.get(subject)?.name ?? fallbackNames.get(subject) ?? subject,
        location: locations.get(batch.locationUuid)?.short ?? fallbackNames.get(batch.locationUuid) ?? batch.locationUuid,
        holderName: batch.designation === 'org' ? holderName : null,
      };
    })
    .sort((a, b) => a.material.localeCompare(b.material) || b.batch.quality - a.batch.quality || a.batch.id - b.batch.id);
}

async function missingNames(db: Db, lang: string, subjects: string[], locations: string[]): Promise<Map<string, string>> {
  if (!subjects.length && !locations.length) return new Map();
  const list = (ids: string[]) => (ids.length ? sql.join(ids.map((u) => sql`${u}::uuid`), sql`, `) : sql`NULL::uuid`);
  const found = await rows<{ uuid: string; name: string }>(db, sql`
    SELECT r.uuid, coalesce(${locText(lang, sql`r.name_key`)}, r.key) AS name FROM catalog.resource r WHERE r.uuid IN (${list(subjects)})
    UNION ALL SELECT i.uuid, coalesce(${locText(lang, sql`i.name_key`)}, i.class_name) FROM catalog.item i WHERE i.uuid IN (${list(subjects)})
    UNION ALL SELECT l.uuid, coalesce(${locText(lang, sql`l.name_key`)}, l.key) FROM catalog.location l WHERE l.uuid IN (${list(locations)})`);
  return new Map(found.map((f) => [f.uuid, f.name]));
}
