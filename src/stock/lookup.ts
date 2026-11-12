// Read side for stock pickers and displays: selectable locations and bookable materials (cached in
// memory per language, reloaded after a newer catalog import) and the batches an actor may change.
// No Discord here: the bot and the web UI build their own labels from these.
import { sql, type SQL } from 'drizzle-orm';
import { isFpsType } from '../catalog/components.ts';
import { ITEM_SUBTYPE_KEY_PREFIX, ITEM_TYPE_KEY_PREFIX, typeLabel } from '../catalog/labels.ts';
import type { Db } from '../db/client.ts';
import { importCache } from '../db/import-cache.ts';
import { itemClassText, locText, rows } from '../db/query.ts';
import type { SubjectKind } from './amount.ts';
import { tooltipForm, type TooltipForm } from './component-base.ts';
import { statBounds, type StatBounds } from './component-stats.ts';
import type { ModifierRange } from '../planner/types.ts';
import { componentItemSql, componentStats, selectableLocationSql, type Actor, type Batch } from './service.ts';

export interface LocationEntry {
  uuid: string;
  // The star map record's key ("RR_CRU_LEO"; the game logs it, e.g. in Game.log)
  key: string;
  name: string;
  nameEn: string;
  // Nearest planet or moon above it, if any
  body: string | null;
  system: string | null;
  // "Area18 · ArcCorp · Stanton"
  label: string;
  // The name, plus the system where the name alone is ambiguous (gateways exist in two systems)
  short: string;
  // The game's localization key of the name (lower case), e.g. for a language pack's text
  nameKey: string | null;
}

export const locationCatalog = importCache(async (db, lang): Promise<Map<string, LocationEntry>> => {
  // The whole star map is small (~2k rows): walk the parents in memory
  const all = await rows<{ uuid: string; key: string; parent: string | null; nav: string | null; name: string | null; nameEn: string | null; nameKey: string | null; selectable: boolean }>(db, sql`
    SELECT l.uuid, l.key, l.parent_uuid AS parent, l.nav_icon AS nav, lower(l.name_key) AS "nameKey", ${locText(lang, sql`l.name_key`)} AS name,
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
    return { uuid: l.uuid, key: l.key, name, nameEn: l.nameEn!, body, system, label: [name, body, system].filter(Boolean).join(' · '), short: name, nameKey: l.nameKey };
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
  // The game's localization key of the name (lower case)
  nameKey: string | null;
  // Gear: a ship component or FPS gear (an item, no quality); the fields below are set for items only
  // (size: not for FPS gear but attachments)
  component: boolean;
  size: number | null;
  gradeLetter: string | null;
  itemClass: string | null;
  // Gear: unique within the catalog ("Name · Cooler · S3 · B Industrial", "Name · Helmets · Light"); else the name
  label: string;
  // Components: the stats a batch can carry (its blueprints' crafted properties); else none
  stats: ComponentStat[];
}

export interface ComponentStat extends StatBounds {
  // The crafted property
  uuid: string;
  // As the game names it ("Coolant Rating")
  name: string;
  // The game's localization key of that name (lower case): API consumers look it up in the player's language pack
  nameKey: string | null;
  // The unmodified value as the game's tooltip shows it (the item's `base_stats`, `component-base.ts`); null when unknown
  base: number | null;
  // How the tooltip shows the stat: its value, or its change in percent (negated for some; `component-base.ts`)
  tooltip: TooltipForm;
}

/**
 * Item UUID -> crafted property UUID -> the unmodified stat value, for every gear stat the item holds one for
 * (`catalog.item.base_stats`, keyed by the crafted property's key). Only stats its blueprints change (the
 * only ones shown).
 */
async function componentBaseValues(db: Db): Promise<Map<string, Map<string, number>>> {
  const found = await rows<{ item: string; property: string; value: string }>(db, sql`
    SELECT i.uuid AS item, cp.uuid AS property, b.value #>> '{}' AS value
    FROM catalog.item i
    CROSS JOIN LATERAL jsonb_each(i.base_stats) b
    JOIN catalog.crafted_property cp ON cp.key = b.key
    WHERE i.retired_at IS NULL AND ${componentItemSql()}
      AND EXISTS (SELECT 1 FROM catalog.blueprint cb JOIN catalog.blueprint_slot s ON s.blueprint_uuid = cb.uuid
        CROSS JOIN LATERAL jsonb_array_elements(s.modifiers) m
        WHERE cb.output_item_uuid = i.uuid AND cb.retired_at IS NULL AND lower(m->>'propertyUuid') = cp.uuid::text)`);
  const bases = new Map<string, Map<string, number>>();
  for (const r of found) {
    const item = bases.get(r.item) ?? new Map<string, number>();
    item.set(r.property, Number(r.value));
    bases.set(r.item, item);
  }
  return bases;
}

/**
 * Per blueprint the names of the stats its slots can change (as componentStats: a flat range is left out),
 * in the tooltip's order (Integrity last). Blueprints without any are missing.
 */
export const blueprintStatNames = importCache(async (db, lang): Promise<Map<string, string[]>> => {
  const found = await rows<{ blueprint: string; key: string; name: string; ranges: ModifierRange[] }>(db, sql`
    SELECT s.blueprint_uuid AS blueprint, cp.key, coalesce(${locText(lang, sql`cp.name_key`)}, cp.key) AS name, m->'ranges' AS ranges
    FROM catalog.blueprint_slot s
    CROSS JOIN LATERAL jsonb_array_elements(s.modifiers) m
    JOIN catalog.crafted_property cp ON cp.uuid::text = lower(m->>'propertyUuid')`);
  // blueprint -> property key -> its name and the slots' ranges
  const grouped = new Map<string, Map<string, { name: string; slots: ModifierRange[][] }>>();
  for (const r of found) {
    const byKey = grouped.get(r.blueprint) ?? new Map<string, { name: string; slots: ModifierRange[][] }>();
    const entry = byKey.get(r.key) ?? { name: r.name, slots: [] };
    entry.slots.push(Array.isArray(r.ranges) ? r.ranges : []);
    byKey.set(r.key, entry);
    grouped.set(r.blueprint, byKey);
  }
  const result = new Map<string, string[]>();
  for (const [blueprint, byKey] of grouped) {
    const names = [...byKey].filter(([, e]) => statBounds(e.slots))
      .sort(([a], [b]) => Number(a === 'GPP_Health_MaxHealth') - Number(b === 'GPP_Health_MaxHealth') || a.localeCompare(b))
      .map(([, e]) => e.name);
    if (names.length) result.set(blueprint, names);
  }
  return result;
});

/** What can be booked: recipe resources and items, and ship components (same rules as the stock service; never ores). */
export const materialCatalog = importCache(async (db, lang): Promise<Map<string, MaterialEntry>> => {
  const found = await rows<Omit<MaterialEntry, 'label' | 'stats'> & {
    className: string | null; type: string | null; typeText: string | null; subType: string | null; subTypeText: string | null;
  }>(db, sql`
    SELECT 'resource' AS kind, r.uuid, coalesce(${locText(lang, sql`r.name_key`)}, r.key) AS name,
      coalesce(${locText('en', sql`r.name_key`)}, r.key) AS "nameEn", lower(r.name_key) AS "nameKey", false AS component,
      NULL::int AS size, NULL AS "gradeLetter", NULL AS "itemClass", NULL AS "className", NULL AS type, NULL AS "typeText",
      NULL AS "subType", NULL AS "subTypeText"
    FROM catalog.resource r
    WHERE r.retired_at IS NULL AND EXISTS (SELECT 1 FROM catalog.blueprint_input bi WHERE bi.resource_uuid = r.uuid)
    UNION ALL
    SELECT 'item', i.uuid, coalesce(${locText(lang, sql`i.name_key`)}, i.class_name),
      coalesce(${locText('en', sql`i.name_key`)}, i.class_name), lower(i.name_key), ${componentItemSql()},
      i.size, i.grade_letter, ${itemClassText(lang, 'i')}, i.class_name, i.type,
      ${locText(lang, sql`${ITEM_TYPE_KEY_PREFIX} || lower(i.type)`)}, i.sub_type,
      ${locText(lang, sql`${ITEM_SUBTYPE_KEY_PREFIX} || lower(i.sub_type)`)}
    FROM catalog.item i
    WHERE i.retired_at IS NULL AND (EXISTS (SELECT 1 FROM catalog.blueprint_input bi WHERE bi.item_uuid = i.uuid) OR ${componentItemSql()})`);
  // FPS gear has no size of note (armor is always 1, weapons 1–5 by kind) but attachments (S1–S4 fit the
  // weapon): only theirs is kept
  for (const m of found) if (m.component && m.type !== 'WeaponAttachment' && isFpsType(m.type, m.subType)) m.size = null;
  // Ship components: "Name · Cooler · S3 · B Industrial"; FPS gear with its sub type, personal weapons without
  // their class: "Name · Helmets · Light", "Name · Attachment · Barrel · S1"
  const labels = found.map((m) => (m.component
    ? [m.name, typeLabel(m.type, m.typeText), isFpsType(m.type, m.subType) ? typeLabel(m.subType, m.subTypeText) : null,
      m.size !== null ? `S${m.size}` : null, [m.gradeLetter, m.type === 'WeaponPersonal' ? null : m.itemClass].filter(Boolean).join(' ') || null]
      .filter(Boolean).join(' · ')
    : m.name));
  const counts = new Map<string, number>();
  found.forEach((m, i) => m.component && counts.set(labels[i]!, (counts.get(labels[i]!) ?? 0) + 1));
  // The stats each component can carry with their bounds, in the tooltip's order (Integrity last)
  const bounds = await componentStats(db, sql`i.retired_at IS NULL`);
  const bases = await componentBaseValues(db);
  const properties = new Map((await rows<{ uuid: string; key: string; name: string; nameKey: string | null; display: unknown }>(db, sql`
    SELECT cp.uuid, cp.key, coalesce(${locText(lang, sql`cp.name_key`)}, cp.key) AS name, lower(cp.name_key) AS "nameKey",
      cp.display_transformation AS display FROM catalog.crafted_property cp`))
    .map((p) => [p.uuid, p]));
  const statsOf = (item: string): ComponentStat[] => [...(bounds.get(item) ?? [])]
    .map(([uuid, b]) => ({
      uuid, name: properties.get(uuid)?.name ?? uuid, key: properties.get(uuid)?.key ?? uuid, nameKey: properties.get(uuid)?.nameKey ?? null,
      base: bases.get(item)?.get(uuid) ?? null, tooltip: tooltipForm(properties.get(uuid)?.display), ...b,
    }))
    .sort((a, b) => Number(a.key === 'GPP_Health_MaxHealth') - Number(b.key === 'GPP_Health_MaxHealth') || a.key.localeCompare(b.key))
    .map(({ key: _k, ...s }) => s);
  // Component labels that still collide get the class name
  return new Map(found.map(({ className, type: _t, typeText: _x, subType: _s, subTypeText: _y, ...m }, i) => {
    const label = m.component && counts.get(labels[i]!)! > 1 ? `${labels[i]} · ${className}` : labels[i]!;
    return [m.uuid, { ...m, label, stats: m.component ? statsOf(m.uuid) : [] }];
  }));
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

/** A refinery job's work order (NULLs on jobs from before they were recorded); the batch's quantity is its expected yield. */
export interface RefineInfo {
  // The work order: every batch of one job shares it
  jobId: string;
  startedAt: string | null;
  endsAt: string | null;
}

export interface PickableBatch {
  batch: Batch;
  material: string;
  // A ship component (also when its catalog entry is retired)
  component: boolean;
  location: string;
  // The owner's name in an org it is shared in (null while unshared)
  holderName: string | null;
  // The orgs it is shared in (guild IDs, also ones whose roster no longer lists the owner)
  sharedIn: string[];
  // Refinery jobs only
  refine: RefineInfo | null;
}

/**
 * Batches the actor may change: their own, shared or not. Ordered by material name, then quality
 * (best first).
 */
export async function pickableBatches(db: Db, actor: Actor, pick: BatchPick, lang: string): Promise<PickableBatch[]> {
  const scope = sql`b.owner_user_id = ${actor.userId}`;
  const state = pick === 'refining' ? sql`b.state = 'refining'` : pick === 'move' ? sql`b.state = 'stored'` : sql`true`;
  return loadBatches(db, sql`${scope} AND ${state}`, lang);
}

export interface StockFilter {
  // Everything this user owns (shared or not), what the org's active members shared there, or both:
  // the user's own plus what was shared in every org they are an active member of
  scope: { personalOf: string } | { guildId: string } | { allOf: string };
  subjectUuid?: string;
  locationUuid?: string;
  // Of this owner only
  holderUserId?: string;
}

// Shared in an org (`guilds`: a guild ID, or a subquery of them): counts there while its owner is an
// active member (someone who left keeps the batch, the org no longer sees it)
const sharedIn = (guilds: SQL) => sql`EXISTS (SELECT 1 FROM app.stock_share s
  JOIN app.member sm ON sm.guild_id = s.guild_id AND sm.user_id = b.owner_user_id AND sm.active
  WHERE s.batch_id = b.id AND s.guild_id IN (${guilds}))`;
const myOrgs = (userId: string) => sql`SELECT guild_id FROM app.member WHERE user_id = ${userId} AND active`;

/** What a list shows: unshared stock only ever to its owner; shared stock to the org's members. */
export function stockList(db: Db, filter: StockFilter, lang: string): Promise<PickableBatch[]> {
  const s = filter.scope;
  const conds = [
    'personalOf' in s ? sql`b.owner_user_id = ${s.personalOf}`
    : 'guildId' in s ? sharedIn(sql`${s.guildId}`)
    : sql`(b.owner_user_id = ${s.allOf} OR ${sharedIn(myOrgs(s.allOf))})`,
  ];
  if (filter.subjectUuid) conds.push(sql`coalesce(b.resource_uuid, b.item_uuid) = ${filter.subjectUuid}`);
  if (filter.locationUuid) conds.push(sql`b.location_uuid = ${filter.locationUuid}`);
  if (filter.holderUserId) conds.push(sql`b.owner_user_id = ${filter.holderUserId}`);
  return loadBatches(db, sql.join(conds, sql` AND `), lang);
}

/** Stored batches of a material shared in the org plus the user's own, best quality first. */
export async function findStock(db: Db, guildId: string, userId: string, subjectUuid: string, minQuality: number, lang: string) {
  const found = await loadBatches(db, sql`(${sharedIn(sql`${guildId}`)} OR b.owner_user_id = ${userId})
    AND coalesce(b.resource_uuid, b.item_uuid) = ${subjectUuid} AND b.quality >= ${minQuality} AND b.state = 'stored'`, lang);
  return found.sort((a, b) => b.batch.quality - a.batch.quality || a.batch.id - b.batch.id);
}

/** Batches matching `where` (alias `b`) with display names, ordered by material, then quality (best first). */
async function loadBatches(db: Db, where: SQL, lang: string): Promise<PickableBatch[]> {
  const found = await rows<Batch & { holderName: string | null; sharedIn: string[]; refine: RefineInfo; component: boolean }>(db, sql`
    SELECT b.id::int AS id, b.owner_user_id AS "ownerUserId", b.kind, ${componentItemSql('b.item_uuid')} AS component,
      b.resource_uuid AS "resourceUuid", b.item_uuid AS "itemUuid", b.location_uuid AS "locationUuid", b.state, b.quality,
      b.quantity::text AS quantity, b.lot, b.stats,
      coalesce((SELECT array_agg(s.guild_id ORDER BY s.guild_id) FROM app.stock_share s WHERE s.batch_id = b.id), '{}') AS "sharedIn",
      (SELECT m.display_name FROM app.stock_share s JOIN app.member m ON m.guild_id = s.guild_id AND m.user_id = b.owner_user_id
        WHERE s.batch_id = b.id ORDER BY m.active DESC, s.guild_id LIMIT 1) AS "holderName",
      json_build_object('jobId', b.refine_job, 'startedAt', b.refine_started_at, 'endsAt', b.refine_ends_at) AS refine
    FROM app.stock_batch b
    WHERE ${where}`);
  const [materials, locations] = [await materialCatalog(db, lang), await locationCatalog(db, lang)];
  // Batches may reference retired catalog entries, which the caches leave out: fall back to the names stored in the catalog
  const fallbackNames = await missingNames(db, lang, found.filter((b) => !materials.has(b.resourceUuid ?? b.itemUuid!)).map((b) => b.resourceUuid ?? b.itemUuid!),
    found.filter((b) => !locations.has(b.locationUuid)).map((b) => b.locationUuid));
  return found
    .map(({ holderName, sharedIn: shares, refine, component, ...batch }) => {
      const subject = batch.resourceUuid ?? batch.itemUuid!;
      return {
        batch,
        material: materials.get(subject)?.name ?? fallbackNames.get(subject) ?? subject,
        component,
        location: locations.get(batch.locationUuid)?.short ?? fallbackNames.get(batch.locationUuid) ?? batch.locationUuid,
        holderName,
        sharedIn: shares,
        refine: batch.state === 'refining' ? refine : null,
      };
    })
    .sort((a, b) => a.material.localeCompare(b.material) || b.batch.quality - a.batch.quality || a.batch.id - b.batch.id);
}

/** Names of materials and locations the caches leave out (retired), from the catalog. */
export async function missingNames(db: Db, lang: string, subjects: string[], locations: string[]): Promise<Map<string, string>> {
  if (!subjects.length && !locations.length) return new Map();
  const list = (ids: string[]) => (ids.length ? sql.join(ids.map((u) => sql`${u}::uuid`), sql`, `) : sql`NULL::uuid`);
  const found = await rows<{ uuid: string; name: string }>(db, sql`
    SELECT r.uuid, coalesce(${locText(lang, sql`r.name_key`)}, r.key) AS name FROM catalog.resource r WHERE r.uuid IN (${list(subjects)})
    UNION ALL SELECT i.uuid, coalesce(${locText(lang, sql`i.name_key`)}, i.class_name) FROM catalog.item i WHERE i.uuid IN (${list(subjects)})
    UNION ALL SELECT l.uuid, coalesce(${locText(lang, sql`l.name_key`)}, l.key) FROM catalog.location l WHERE l.uuid IN (${list(locations)})`);
  return new Map(found.map((f) => [f.uuid, f.name]));
}

/** Sum of a material in one stock (everything a user has stored, or what is shared in an org; never refinery jobs), as NUMERIC text ("0" if none). */
export async function materialTotal(db: Db, scope: { personalOf: string } | { guildId: string }, subjectUuid: string): Promise<string> {
  const where = 'personalOf' in scope
    ? sql`b.owner_user_id = ${scope.personalOf}`
    : sharedIn(sql`${scope.guildId}`);
  const found = await rows<{ total: string }>(db, sql`
    SELECT coalesce(sum(b.quantity), 0)::text AS total FROM app.stock_batch b
    WHERE ${where} AND b.state = 'stored' AND coalesce(b.resource_uuid, b.item_uuid) = ${subjectUuid}`);
  return found[0]!.total;
}

export interface OrgName {
  guildId: string;
  name: string;
}

/** The orgs the user is an active member of (where they may share), by name. */
export function activeOrgs(db: Db, userId: string): Promise<OrgName[]> {
  return rows<OrgName>(db, sql`
    SELECT o.guild_id AS "guildId", o.name FROM app.member m JOIN app.org o ON o.guild_id = m.guild_id
    WHERE m.user_id = ${userId} AND m.active ORDER BY lower(o.name)`);
}

/** Names of these orgs (e.g. where a batch is shared), unknown ones left out. */
export function orgNames(db: Db, guildIds: string[]): Promise<OrgName[]> {
  if (!guildIds.length) return Promise.resolve([]);
  return rows<OrgName>(db, sql`
    SELECT guild_id AS "guildId", name FROM app.org WHERE guild_id IN (${sql.join(guildIds.map((g) => sql`${g}`), sql`, `)}) ORDER BY lower(name)`);
}
