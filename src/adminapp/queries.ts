// Read-only queries for the admin API. Names resolve through localization_effective:
// requested language, then English, then the technical name.
import { sql, type SQL } from 'drizzle-orm';
import type { Db } from '../db/client.ts';
import { REWARD_POOL_PATHS, categoryText, itemClassText, locText as text, one, rows, withCategoryLabel } from '../db/query.ts';
import {
  BLUEPRINT_CATEGORY_GROUP_SQL, BLUEPRINT_CATEGORY_KEY_PREFIX, ITEM_SUBTYPE_KEY_PREFIX, ITEM_TYPE_KEY_PREFIX, typeLabel,
} from '../catalog/labels.ts';
import type {
  BlueprintDetail, BlueprintRow, BlueprintSlot, EntityCount, GameInfo, ImportDetail, ImportRow, ItemDetail, ItemRow,
  LocKeyDetail, LocSearch, LocSource, Meta, Overview, Ref, ResourceDetail, ResourceRow, UexEndpointStatus, UexMethod, UexRefinery, UexResponse,
  UexTradeResponse,
} from './api-types.ts';
import { COMPONENT_TYPES, fpsTypeSql } from '../catalog/components.ts';
import { locationCatalog } from '../stock/lookup.ts';
import { refineryMatch, refiningMethods, uexTerminals } from '../ext/refineries.ts';
import { nameKey, tradeData } from '../ext/trade.ts';

/** Timestamp as ISO 8601 string (the driver would return Postgres' text format here). */
const iso = (column: string) => sql.raw(`to_json(${column}) #>> '{}'`);

export async function getMeta(db: Db): Promise<Meta> {
  const game = await one<GameInfo>(db, sql`
    SELECT channel, game_build AS build, game_label AS label, game_branch AS branch, id AS "importId", ${iso('imported_at')} AS "importedAt"
    FROM catalog.import ORDER BY id DESC LIMIT 1`);
  const langs = await rows<{ lang: string }>(db, sql`
    SELECT lang FROM catalog.localization_source GROUP BY lang
    ORDER BY lang`);
  return { game, langs: langs.map((l) => l.lang) };
}

const IMPORT_ROW = sql`id, channel, game_build AS "gameBuild", game_label AS "gameLabel", ${iso('imported_at')} AS "importedAt", forced,
  coalesce(jsonb_array_length(anomalies), 0) AS "anomalyCount"`;

export async function getOverview(db: Db, lang: string): Promise<Overview> {
  const counts = await rows<EntityCount>(db, sql`
    SELECT entity, active::int, retired::int FROM (
      SELECT 'blueprint' AS entity, 1 AS ord, count(*) FILTER (WHERE retired_at IS NULL) AS active, count(*) FILTER (WHERE retired_at IS NOT NULL) AS retired FROM catalog.blueprint
      UNION ALL SELECT 'item', 2, count(*) FILTER (WHERE retired_at IS NULL), count(*) FILTER (WHERE retired_at IS NOT NULL) FROM catalog.item
      UNION ALL SELECT 'resource', 3, count(*) FILTER (WHERE retired_at IS NULL), count(*) FILTER (WHERE retired_at IS NOT NULL) FROM catalog.resource
      UNION ALL SELECT 'manufacturer', 4, count(*) FILTER (WHERE retired_at IS NULL), count(*) FILTER (WHERE retired_at IS NOT NULL) FROM catalog.manufacturer
      UNION ALL SELECT 'blueprintCategory', 5, count(*) FILTER (WHERE retired_at IS NULL), count(*) FILTER (WHERE retired_at IS NOT NULL) FROM catalog.blueprint_category
      UNION ALL SELECT 'craftedProperty', 6, count(*) FILTER (WHERE retired_at IS NULL), count(*) FILTER (WHERE retired_at IS NOT NULL) FROM catalog.crafted_property
      UNION ALL SELECT 'qualityQuantization', 7, count(*) FILTER (WHERE retired_at IS NULL), count(*) FILTER (WHERE retired_at IS NOT NULL) FROM catalog.quality_quantization
      UNION ALL SELECT 'rawRecord', 8, count(*) FILTER (WHERE retired_at IS NULL), count(*) FILTER (WHERE retired_at IS NOT NULL) FROM catalog.raw_record
    ) c ORDER BY active DESC, ord`);
  const imports = await rows<ImportRow>(db, sql`SELECT ${IMPORT_ROW} FROM catalog.import ORDER BY id DESC LIMIT 5`);

  const sources = new Map<string, Overview['sources'][number]>();
  for (const s of await getLocSources(db)) {
    const sum = sources.get(s.source) ?? { source: s.source, langs: [], minPriority: s.priority, maxPriority: s.priority, keyCount: 0 };
    sum.langs.push(s.lang);
    sum.minPriority = Math.min(sum.minPriority, s.priority);
    sum.maxPriority = Math.max(sum.maxPriority, s.priority);
    sum.keyCount += s.keyCount;
    sources.set(s.source, sum);
  }

  const categories = (await rows<{ category: string; categoryLabel: string | null; count: number }>(db, sql`
    SELECT c.key AS category, ${categoryText(lang)} AS "categoryLabel", count(*)::int AS count
    FROM catalog.blueprint b JOIN catalog.blueprint_category c ON c.uuid = b.category_uuid
    WHERE b.retired_at IS NULL GROUP BY c.key`)).map(withCategoryLabel);
  const byGroup = new Map<string, Overview['categories'][number]>();
  for (const c of categories) {
    const g = byGroup.get(c.categoryGroup!) ?? { group: c.categoryGroup!, label: c.categoryLabel!, count: 0 };
    g.count += c.count;
    byGroup.set(g.group, g);
  }

  const topMaterials = await rows<Overview['topMaterials'][number]>(db, sql`
    SELECT bi.kind, coalesce(bi.resource_uuid, bi.item_uuid) AS uuid,
      coalesce(${text(lang, sql`coalesce(r.name_key, i.name_key)`)}, r.key, i.class_name) AS name,
      count(DISTINCT bi.blueprint_uuid)::int AS recipes
    FROM catalog.blueprint_input bi
    JOIN catalog.blueprint b ON b.uuid = bi.blueprint_uuid AND b.retired_at IS NULL
    LEFT JOIN catalog.resource r ON r.uuid = bi.resource_uuid
    LEFT JOIN catalog.item i ON i.uuid = bi.item_uuid
    GROUP BY 1, 2, 3 ORDER BY recipes DESC, name LIMIT 8`);

  const facts = await one<Omit<Overview['facts'], 'longestCraft' | 'lastImport'>>(db, sql`
    SELECT
      (SELECT count(*) FROM catalog.blueprint WHERE retired_at IS NULL AND is_default)::int AS "defaultBlueprints",
      (SELECT count(DISTINCT bi.blueprint_uuid) FROM catalog.blueprint_input bi JOIN catalog.blueprint b ON b.uuid = bi.blueprint_uuid
        WHERE b.retired_at IS NULL AND bi.min_quality > 1)::int AS "qualityGated",
      (SELECT count(*) FROM catalog.blueprint_tier t JOIN catalog.blueprint b ON b.uuid = t.blueprint_uuid
        WHERE b.retired_at IS NULL AND t.required_slots < (SELECT count(*) FROM catalog.blueprint_slot s
          WHERE s.blueprint_uuid = t.blueprint_uuid AND s.tier_index = t.tier_index))::int AS "slotChoice",
      (SELECT count(DISTINCT bi.resource_uuid) FROM catalog.blueprint_input bi JOIN catalog.blueprint b ON b.uuid = bi.blueprint_uuid
        WHERE b.retired_at IS NULL)::int AS "resourcesInRecipes",
      (SELECT count(DISTINCT bi.item_uuid) FROM catalog.blueprint_input bi JOIN catalog.blueprint b ON b.uuid = bi.blueprint_uuid
        WHERE b.retired_at IS NULL)::int AS "itemsInRecipes",
      (SELECT avg(t.craft_seconds)::float8 FROM catalog.blueprint_tier t JOIN catalog.blueprint b ON b.uuid = t.blueprint_uuid
        WHERE b.retired_at IS NULL AND t.tier_index = 0) AS "avgCraftSeconds"`);
  const longestCraft = await one<NonNullable<Overview['facts']['longestCraft']>>(db, sql`
    SELECT b.uuid, coalesce(${text(lang, sql`i.name_key`)}, i.class_name, b.key) AS name, t.craft_seconds::float8 AS seconds
    FROM catalog.blueprint_tier t JOIN catalog.blueprint b ON b.uuid = t.blueprint_uuid AND b.retired_at IS NULL
    LEFT JOIN catalog.item i ON i.uuid = b.output_item_uuid
    WHERE t.tier_index = 0 ORDER BY t.craft_seconds DESC, b.key LIMIT 1`);
  const texts = await rows<Overview['gaps']['texts'][number]>(db, sql`
    WITH k AS (SELECT key, bool_or(lang = ${lang}) AS in_lang FROM catalog.localization GROUP BY key),
    t AS (
      SELECT 'item' AS entity, i.name_key AS key FROM catalog.item i WHERE i.retired_at IS NULL
      UNION ALL SELECT 'resource', r.name_key FROM catalog.resource r WHERE r.retired_at IS NULL
      UNION ALL SELECT 'slot', s.name_key FROM (SELECT DISTINCT name_key FROM catalog.blueprint_slot) s
      UNION ALL SELECT 'stat', p.name_key FROM catalog.crafted_property p WHERE p.retired_at IS NULL
      UNION ALL SELECT 'type', x.key FROM (SELECT DISTINCT ${ITEM_TYPE_KEY_PREFIX} || lower(type) AS key FROM catalog.item WHERE type IS NOT NULL) x
      UNION ALL SELECT 'category', x.key FROM (SELECT DISTINCT ${BLUEPRINT_CATEGORY_KEY_PREFIX} || lower(${sql.raw(BLUEPRINT_CATEGORY_GROUP_SQL)}) AS key
        FROM catalog.blueprint_category c WHERE c.retired_at IS NULL) x
    )
    SELECT entity, count(*)::int AS total,
      count(*) FILTER (WHERE k.key IS NULL OR NOT k.in_lang)::int AS "missingInLang",
      count(*) FILTER (WHERE k.key IS NULL)::int AS "missingEverywhere"
    FROM t LEFT JOIN k ON k.key = t.key GROUP BY entity ORDER BY "missingEverywhere" DESC, "missingInLang" DESC, entity`);
  const registeredNoSource = await rows<Overview['gaps']['registeredNoSource'][number]>(db, sql`
    SELECT b.uuid, coalesce(${text(lang, sql`i.name_key`)}, i.class_name, b.key) AS name, count(*)::int AS users
    FROM app.user_blueprint ub JOIN catalog.blueprint b ON b.uuid = ub.blueprint_uuid
    JOIN catalog.raw_record r ON r.uuid = b.uuid
    LEFT JOIN catalog.item i ON i.uuid = b.output_item_uuid
    WHERE b.retired_at IS NULL AND NOT b.is_default AND r.path NOT IN ${REWARD_POOL_PATHS}
    GROUP BY b.uuid, 2 ORDER BY users DESC, name`);
  const usage = await one<Omit<Overview['gaps'], 'lang' | 'texts' | 'registeredNoSource'>>(db, sql`
    SELECT
      (SELECT count(*) FROM catalog.blueprint b JOIN catalog.raw_record r ON r.uuid = b.uuid
        WHERE b.retired_at IS NULL AND NOT b.is_default AND r.path NOT IN ${REWARD_POOL_PATHS})::int AS "noSourceBlueprints",
      (SELECT count(*) FROM catalog.blueprint WHERE retired_at IS NULL AND output_item_uuid IS NULL)::int AS "noOutputBlueprints"`);

  const last = await one<{ id: number; counts: { added?: number; changed?: number; retired?: number; revived?: number } | null }>(db, sql`
    SELECT id, summary->'entities'->'blueprint' AS counts FROM catalog.import ORDER BY id DESC LIMIT 1`);

  return {
    counts,
    imports,
    sources: [...sources.values()].sort((a, b) => b.maxPriority - a.maxPriority || a.source.localeCompare(b.source)),
    categories: [...byGroup.values()].sort((a, b) => b.count - a.count || a.label.localeCompare(b.label)),
    topMaterials,
    facts: {
      defaultBlueprints: facts?.defaultBlueprints ?? 0,
      qualityGated: facts?.qualityGated ?? 0,
      slotChoice: facts?.slotChoice ?? 0,
      resourcesInRecipes: facts?.resourcesInRecipes ?? 0,
      itemsInRecipes: facts?.itemsInRecipes ?? 0,
      avgCraftSeconds: facts?.avgCraftSeconds ?? null,
      longestCraft,
      lastImport: last ? {
        id: last.id,
        added: last.counts?.added ?? 0,
        changed: last.counts?.changed ?? 0,
        retired: last.counts?.retired ?? 0,
        revived: last.counts?.revived ?? 0,
      } : null,
    },
    gaps: {
      lang,
      texts,
      noSourceBlueprints: usage?.noSourceBlueprints ?? 0,
      registeredNoSource,
      noOutputBlueprints: usage?.noOutputBlueprints ?? 0,
    },
  };
}

export async function getImports(db: Db): Promise<ImportRow[]> {
  return rows<ImportRow>(db, sql`SELECT ${IMPORT_ROW} FROM catalog.import ORDER BY id DESC`);
}

export async function getImport(db: Db, id: number): Promise<ImportDetail | null> {
  return one<ImportDetail>(db, sql`
    SELECT ${IMPORT_ROW}, game_branch AS "gameBranch", game_version AS "gameVersion", snapshot_sha256 AS "snapshotSha256",
      extractor_version AS "extractorVersion", starbreaker_version AS "starbreakerVersion", ${iso('extracted_at')} AS "extractedAt",
      summary, coalesce(anomalies, '[]'::jsonb) AS anomalies
    FROM catalog.import WHERE id = ${id}`);
}

/** Game texts of an item's type and sub type (`alias` = the joined item). */
const typeText = (lang: string, alias: string) => text(lang, sql`${ITEM_TYPE_KEY_PREFIX} || lower(${sql.raw(`${alias}.type`)})`);
const subTypeText = (lang: string, alias: string) => text(lang, sql`${ITEM_SUBTYPE_KEY_PREFIX} || lower(${sql.raw(`${alias}.sub_type`)})`);

/** Replaces the raw type texts with display names (derived where the game has none). */
function withTypeLabels<T extends { typeLabel: string | null; subTypeLabel: string | null }>(
  row: T, type: string | null, subType: string | null,
): T {
  return { ...row, typeLabel: typeLabel(type, row.typeLabel), subTypeLabel: typeLabel(subType, row.subTypeLabel) };
}

const LIFECYCLE = (alias: string) => sql.raw(`${alias}.first_seen_import_id AS "firstSeenImportId",
  ${alias}.last_seen_import_id AS "lastSeenImportId", to_json(${alias}.retired_at) #>> '{}' AS "retiredAt"`);

export async function getBlueprints(db: Db, lang: string): Promise<BlueprintRow[]> {
  return (await rows<BlueprintRow>(db, sql`
    SELECT b.uuid, b.key, coalesce(${text(lang, sql`i.name_key`)}, i.class_name, b.key) AS name,
      i.class_name AS "outputClass", i.type AS "outputType", i.sub_type AS "outputSubType", i.size, i.grade,
      ${typeText(lang, 'i')} AS "outputTypeLabel", ${subTypeText(lang, 'i')} AS "outputSubTypeLabel",
      i.grade_letter AS "gradeLetter", ${itemClassText(lang, 'i')} AS "itemClass",
      m.code AS manufacturer, c.key AS category, ${categoryText(lang)} AS "categoryLabel",
      b.is_default AS "isDefault", t.craft_seconds::float8 AS "craftSeconds",
      (SELECT count(*) FROM catalog.blueprint_slot s WHERE s.blueprint_uuid = b.uuid AND s.tier_index = 0)::int AS "slotCount",
      b.retired_at IS NOT NULL AS retired
    FROM catalog.blueprint b
    LEFT JOIN catalog.item i ON i.uuid = b.output_item_uuid
    LEFT JOIN catalog.manufacturer m ON m.uuid = i.manufacturer_uuid
    LEFT JOIN catalog.blueprint_category c ON c.uuid = b.category_uuid
    LEFT JOIN catalog.blueprint_tier t ON t.blueprint_uuid = b.uuid AND t.tier_index = 0
    ORDER BY b.key`)).map((r) => ({
    ...withCategoryLabel(r),
    outputTypeLabel: typeLabel(r.outputType, r.outputTypeLabel),
    outputSubTypeLabel: typeLabel(r.outputSubType, r.outputSubTypeLabel),
  }));
}

export async function getBlueprint(db: Db, uuid: string, lang: string): Promise<BlueprintDetail | null> {
  const bp = await one<Omit<BlueprintDetail, 'output' | 'tiers'> & { outputUuid: string | null }>(db, sql`
    SELECT b.uuid, b.key, coalesce(${text(lang, sql`i.name_key`)}, i.class_name, b.key) AS name, b.is_default AS "isDefault",
      c.key AS category, ${categoryText(lang)} AS "categoryLabel", b.output_item_uuid AS "outputUuid", ${LIFECYCLE('b')}, r.data AS raw
    FROM catalog.blueprint b
    LEFT JOIN catalog.item i ON i.uuid = b.output_item_uuid
    LEFT JOIN catalog.blueprint_category c ON c.uuid = b.category_uuid
    LEFT JOIN catalog.raw_record r ON r.uuid = b.uuid
    WHERE b.uuid = ${uuid}`);
  if (!bp) return null;

  const output = bp.outputUuid ? await one<NonNullable<BlueprintDetail['output']>>(db, sql`
    SELECT i.uuid, i.class_name AS key, i.class_name AS "className", coalesce(${text(lang, sql`i.name_key`)}, i.class_name) AS name,
      i.type, i.sub_type AS "subType", ${typeText(lang, 'i')} AS "typeLabel", ${subTypeText(lang, 'i')} AS "subTypeLabel",
      i.size, i.grade, i.grade_letter AS "gradeLetter", ${itemClassText(lang, 'i')} AS "itemClass", m.code AS manufacturer
    FROM catalog.item i LEFT JOIN catalog.manufacturer m ON m.uuid = i.manufacturer_uuid WHERE i.uuid = ${bp.outputUuid}`) : null;

  const tiers = await rows<{ index: number; craftSeconds: number; requiredSlots: number }>(db, sql`
    SELECT tier_index AS index, craft_seconds::float8 AS "craftSeconds", required_slots AS "requiredSlots"
    FROM catalog.blueprint_tier WHERE blueprint_uuid = ${uuid} ORDER BY tier_index`);
  const slots = await rows<Omit<BlueprintSlot, 'inputs' | 'modifiers'> & { tierIndex: number; modifiers: BlueprintSlot['modifiers'] }>(db, sql`
    SELECT tier_index AS "tierIndex", slot_index AS index, key, ${text(lang, sql`name_key`)} AS name, required_count AS "requiredCount", modifiers
    FROM catalog.blueprint_slot WHERE blueprint_uuid = ${uuid} ORDER BY tier_index, slot_index`);
  const inputs = await rows<BlueprintSlot['inputs'][number] & { tierIndex: number; slotIndex: number }>(db, sql`
    SELECT bi.tier_index AS "tierIndex", bi.slot_index AS "slotIndex", bi.kind, coalesce(bi.resource_uuid, bi.item_uuid) AS uuid,
      coalesce(r.key, i.class_name) AS key,
      coalesce(${text(lang, sql`coalesce(r.name_key, i.name_key)`)}, r.key, i.class_name) AS name,
      bi.quantity::text AS quantity, bi.min_quality AS "minQuality"
    FROM catalog.blueprint_input bi
    LEFT JOIN catalog.resource r ON r.uuid = bi.resource_uuid
    LEFT JOIN catalog.item i ON i.uuid = bi.item_uuid
    WHERE bi.blueprint_uuid = ${uuid} ORDER BY bi.tier_index, bi.slot_index, bi.input_index`);
  const properties = new Map((await rows<{ uuid: string; key: string; name: string | null; unit: string | null }>(db, sql`
    SELECT uuid, key, ${text(lang, sql`name_key`)} AS name, ${text(lang, sql`unit_key`)} AS unit FROM catalog.crafted_property`))
    .map((p) => [p.uuid, p]));

  const { outputUuid: _outputUuid, ...rest } = bp;
  return {
    ...withCategoryLabel(rest),
    output: output && withTypeLabels(output, output.type, output.subType),
    tiers: tiers.map((t) => ({
      ...t,
      slots: slots.filter((s) => s.tierIndex === t.index).map(({ tierIndex: _tierIndex, ...s }) => ({
        ...s,
        modifiers: (s.modifiers as { propertyUuid: string; ranges: BlueprintSlot['modifiers'][number]['ranges'] }[])
          .map((m) => ({ ...m, property: properties.get(m.propertyUuid) ?? null })),
        inputs: inputs.filter((i) => i.tierIndex === t.index && i.slotIndex === s.index)
          .map(({ tierIndex: _t, slotIndex: _s, ...i }) => i),
      })),
    })),
  };
}

export async function getResources(db: Db, lang: string): Promise<ResourceRow[]> {
  return rows<ResourceRow>(db, sql`
    SELECT r.uuid, r.key, coalesce(${text(lang, sql`r.name_key`)}, r.key) AS name, array_to_string(r.group_path, ' / ') AS "group",
      r.is_ore AS "isOre", r.box_sizes_scu::text[] AS "boxSizes",
      (SELECT count(DISTINCT bi.blueprint_uuid) FROM catalog.blueprint_input bi JOIN catalog.blueprint b ON b.uuid = bi.blueprint_uuid
        WHERE bi.resource_uuid = r.uuid AND b.retired_at IS NULL)::int AS "usedIn",
      r.retired_at IS NOT NULL AS retired
    FROM catalog.resource r ORDER BY r.key`);
}

export async function getResource(db: Db, uuid: string, lang: string): Promise<ResourceDetail | null> {
  const r = await one<Omit<ResourceDetail, 'refined' | 'ores' | 'usedBy' | 'qualityBands'> & { refinedUuid: string | null; craftingData: { qualityQuantizationUuid: string | null }[] }>(db, sql`
    SELECT r.uuid, r.key, coalesce(${text(lang, sql`r.name_key`)}, r.key) AS name, ${text(lang, sql`r.description_key`)} AS description,
      r.group_path AS "groupPath", r.is_ore AS "isOre", r.density_g_per_cc::text AS "densityGPerCc", r.box_sizes_scu::text[] AS "boxSizes",
      r.refined_uuid AS "refinedUuid", r.crafting_data AS "craftingData", ${LIFECYCLE('r')}, r.data AS raw
    FROM catalog.resource r WHERE r.uuid = ${uuid}`);
  if (!r) return null;
  const ref = (where: SQL) => rows<Ref>(db, sql`
    SELECT r.uuid, r.key, coalesce(${text(lang, sql`r.name_key`)}, r.key) AS name FROM catalog.resource r WHERE ${where} ORDER BY r.key`);
  const refined = r.refinedUuid ? (await ref(sql`r.uuid = ${r.refinedUuid}`))[0] ?? null : null;
  const ores = await ref(sql`r.refined_uuid = ${uuid}`);
  const quantizationUuid = r.craftingData.find((c) => c.qualityQuantizationUuid)?.qualityQuantizationUuid ?? null;
  const bands = quantizationUuid
    ? await one<{ bands: ResourceDetail['qualityBands'] }>(db, sql`SELECT bands FROM catalog.quality_quantization WHERE uuid = ${quantizationUuid}`)
    : null;
  const usedBy = await rows<ResourceDetail['usedBy'][number]>(db, sql`
    SELECT b.uuid, b.key, coalesce(${text(lang, sql`i.name_key`)}, i.class_name, b.key) AS name,
      bi.quantity::text AS quantity, bi.min_quality AS "minQuality", s.key AS slot
    FROM catalog.blueprint_input bi
    JOIN catalog.blueprint b ON b.uuid = bi.blueprint_uuid AND b.retired_at IS NULL
    JOIN catalog.blueprint_slot s ON s.blueprint_uuid = bi.blueprint_uuid AND s.tier_index = bi.tier_index AND s.slot_index = bi.slot_index
    LEFT JOIN catalog.item i ON i.uuid = b.output_item_uuid
    WHERE bi.resource_uuid = ${uuid} ORDER BY name`);
  const { refinedUuid: _refinedUuid, craftingData: _craftingData, ...rest } = r;
  return { ...rest, refined, ores, qualityBands: bands?.bands ?? null, usedBy };
}

export async function getItems(db: Db, lang: string): Promise<ItemRow[]> {
  return (await rows<ItemRow>(db, sql`
    SELECT i.uuid, i.class_name AS "className", coalesce(${text(lang, sql`i.name_key`)}, i.class_name) AS name,
      i.type, i.sub_type AS "subType", ${typeText(lang, 'i')} AS "typeLabel", ${subTypeText(lang, 'i')} AS "subTypeLabel",
      i.size, i.grade, i.grade_letter AS "gradeLetter", ${itemClassText(lang, 'i')} AS "itemClass", m.code AS manufacturer,
      (SELECT count(*) FROM catalog.blueprint b WHERE b.output_item_uuid = i.uuid AND b.retired_at IS NULL)::int AS "asOutput",
      (SELECT count(DISTINCT bi.blueprint_uuid) FROM catalog.blueprint_input bi JOIN catalog.blueprint b ON b.uuid = bi.blueprint_uuid
        WHERE bi.item_uuid = i.uuid AND b.retired_at IS NULL)::int AS "asInput",
      i.retired_at IS NOT NULL AS retired
    FROM catalog.item i LEFT JOIN catalog.manufacturer m ON m.uuid = i.manufacturer_uuid ORDER BY i.class_name`))
    .map((r) => withTypeLabels(r, r.type, r.subType));
}

export async function getItem(db: Db, uuid: string, lang: string): Promise<ItemDetail | null> {
  const item = await one<Omit<ItemDetail, 'outputOf' | 'inputOf' | 'manufacturer'> & { manufacturerCode: string | null; manufacturerName: string | null; hasManufacturer: boolean }>(db, sql`
    SELECT i.uuid, i.class_name AS "className", coalesce(${text(lang, sql`i.name_key`)}, i.class_name) AS name,
      ${text(lang, sql`i.description_key`)} AS description, i.type, i.sub_type AS "subType",
      ${typeText(lang, 'i')} AS "typeLabel", ${subTypeText(lang, 'i')} AS "subTypeLabel", i.size, i.grade,
      i.grade_letter AS "gradeLetter", ${itemClassText(lang, 'i')} AS "itemClass",
      m.uuid IS NOT NULL AS "hasManufacturer", m.code AS "manufacturerCode", ${text(lang, sql`m.name_key`)} AS "manufacturerName",
      ${LIFECYCLE('i')}, r.data AS raw
    FROM catalog.item i
    LEFT JOIN catalog.manufacturer m ON m.uuid = i.manufacturer_uuid
    LEFT JOIN catalog.raw_record r ON r.uuid = i.uuid
    WHERE i.uuid = ${uuid}`);
  if (!item) return null;
  const outputOf = await rows<Ref>(db, sql`
    SELECT b.uuid, b.key, coalesce(${text(lang, sql`i.name_key`)}, i.class_name, b.key) AS name
    FROM catalog.blueprint b LEFT JOIN catalog.item i ON i.uuid = b.output_item_uuid
    WHERE b.output_item_uuid = ${uuid} AND b.retired_at IS NULL ORDER BY b.key`);
  const inputOf = await rows<ItemDetail['inputOf'][number]>(db, sql`
    SELECT b.uuid, b.key, coalesce(${text(lang, sql`o.name_key`)}, o.class_name, b.key) AS name,
      bi.quantity::text AS quantity, bi.min_quality AS "minQuality", s.key AS slot
    FROM catalog.blueprint_input bi
    JOIN catalog.blueprint b ON b.uuid = bi.blueprint_uuid AND b.retired_at IS NULL
    JOIN catalog.blueprint_slot s ON s.blueprint_uuid = bi.blueprint_uuid AND s.tier_index = bi.tier_index AND s.slot_index = bi.slot_index
    LEFT JOIN catalog.item o ON o.uuid = b.output_item_uuid
    WHERE bi.item_uuid = ${uuid} ORDER BY name`);
  const { manufacturerCode, manufacturerName, hasManufacturer, ...rest } = item;
  return {
    ...withTypeLabels(rest, rest.type, rest.subType),
    manufacturer: hasManufacturer ? { code: manufacturerCode, name: manufacturerName } : null,
    outputOf,
    inputOf,
  };
}

export async function getLocSources(db: Db): Promise<LocSource[]> {
  return rows<LocSource>(db, sql`
    SELECT source, lang, priority, origin, key_count AS "keyCount", ${iso('imported_at')} AS "importedAt"
    FROM catalog.localization_source ORDER BY priority DESC, source, lang`);
}

/** Effective texts of a language whose key or text contains the query (case-insensitive). */
export async function searchLoc(db: Db, lang: string, query: string, limit: number): Promise<LocSearch> {
  const pattern = `%${query.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  const where = sql`e.lang = ${lang} AND (e.key ILIKE ${pattern} OR e.value ILIKE ${pattern})`;
  const [count] = await rows<{ n: number }>(db, sql`SELECT count(*)::int AS n FROM catalog.localization_effective e WHERE ${where}`);
  const found = await rows<LocSearch['rows'][number]>(db, sql`
    SELECT e.key, e.value, e.source FROM catalog.localization_effective e WHERE ${where}
    ORDER BY e.key ILIKE ${pattern} DESC, e.key LIMIT ${limit}`);
  return { total: count?.n ?? 0, rows: found };
}

/** One key in every language and source; `effective` marks the winning text per language. */
export async function getLocKey(db: Db, key: string): Promise<LocKeyDetail> {
  const values = await rows<LocKeyDetail['values'][number]>(db, sql`
    SELECT l.lang, l.source, s.priority, l.value,
      row_number() OVER (PARTITION BY l.lang ORDER BY s.priority DESC, l.source) = 1 AS effective
    FROM catalog.localization l
    JOIN catalog.localization_source s ON s.source = l.source AND s.lang = l.lang
    WHERE l.key = ${key}
    ORDER BY l.lang = 'en' DESC, l.lang, s.priority DESC, l.source`);
  return { key, values };
}

// --- 3rd party: UEX --------------------------------------------------------------------------------

/** Pull status, refinery terminals with their catalog match and yield bonuses, methods. */
/** The latest snapshot of every pulled UEX endpoint. */
export function uexEndpoints(db: Db): Promise<UexEndpointStatus[]> {
  return rows<UexEndpointStatus>(db, sql`
    SELECT DISTINCT ON (endpoint) endpoint, jsonb_array_length(data) AS rows,
      (count(*) OVER (PARTITION BY endpoint))::int AS snapshots, ${iso('fetched_at')} AS "changedAt", ${iso('checked_at')} AS "checkedAt"
    FROM ext.snapshot WHERE source = 'uex' ORDER BY endpoint, id DESC`);
}

export async function getUex(db: Db, lang: string): Promise<UexResponse> {
  const endpoints = await uexEndpoints(db);
  const latest = async (endpoint: string) => (await one<{ data: Record<string, unknown>[] }>(db, sql`
    SELECT data FROM ext.snapshot WHERE source = 'uex' AND endpoint = ${endpoint} ORDER BY id DESC LIMIT 1`))?.data ?? [];
  const [yields, methods] = [await latest('refineries_yields'), await latest('refineries_methods')];

  const match = await refineryMatch(db);
  const byTerminal = new Map([...match?.matched ?? []].map(([uuid, t]) => [t.id, uuid]));
  const locations = await locationCatalog(db, lang);
  const ores = new Set<string>();
  const refineries = uexTerminals(yields).map((t): UexRefinery => {
    const uuid = byTerminal.get(t.id) ?? null;
    return { terminalId: t.id, terminal: t.name, system: t.system, place: t.place, locationUuid: uuid, location: uuid ? locations.get(uuid)?.label ?? null : null, yields: {} };
  });
  const byId = new Map(refineries.map((r) => [r.terminalId, r]));
  for (const y of yields) {
    const r = byId.get(y.id_terminal as number);
    if (!r || typeof y.commodity_name !== 'string' || typeof y.value !== 'number') continue;
    r.yields[y.commodity_name] = y.value;
    ores.add(y.commodity_name);
  }
  return {
    endpoints,
    refineries: refineries.sort((a, b) => a.system.localeCompare(b.system) || a.place.localeCompare(b.place)),
    ores: [...ores].sort((a, b) => a.localeCompare(b)),
    methods: await joinMethods(db, lang, methods),
  };
}

/** Trade coverage: what of the catalog the UEX trade data (trade.ts) reach, matched the same way. */
export async function getUexTrade(db: Db, lang: string): Promise<UexTradeResponse> {
  const rowCount = new Map((await uexEndpoints(db)).map((e) => [e.endpoint, e.rows]));
  const names = (await rows<{ name: string }>(db, sql`
    SELECT c->>'name' AS name FROM ext.snapshot s CROSS JOIN jsonb_array_elements(s.data) c
    WHERE s.id = (SELECT max(id) FROM ext.snapshot WHERE source = 'uex' AND endpoint = 'commodities') AND c->>'name' IS NOT NULL`))
    .map((c) => c.name);
  // The English name as trade.ts matches it; the shown name in the requested language
  const resources = await rows<{ uuid: string; name: string; nameEn: string; isOre: boolean }>(db, sql`
    SELECT r.uuid, coalesce(${text(lang, sql`r.name_key`)}, r.key) AS name, coalesce(${text('en', sql`r.name_key`)}, r.key) AS "nameEn",
      r.is_ore AS "isOre"
    FROM catalog.resource r WHERE r.retired_at IS NULL`);
  const items = await rows<{ uuid: string; gear: boolean }>(db, sql`
    SELECT i.uuid, (i.type IN (${sql.join(COMPONENT_TYPES.map((t) => sql`${t}`), sql`, `)}) OR ${sql.raw(fpsTypeSql('i'))}) AS gear
    FROM catalog.item i WHERE i.retired_at IS NULL`);
  const trade = await tradeData(db);

  const resourceKeys = new Set(resources.map((r) => nameKey(r.nameEn)));
  const commodityKeys = new Set(names.map(nameKey));
  const unmatched = resources.filter((r) => !commodityKeys.has(nameKey(r.nameEn)));
  const gear = items.filter((i) => i.gear);
  return {
    terminals: rowCount.get('terminals') ?? 0,
    commodityPrices: rowCount.get('commodities_prices_all') ?? 0,
    itemPrices: rowCount.get('items_prices_all') ?? 0,
    commodities: {
      total: names.length,
      matched: names.filter((n) => resourceKeys.has(nameKey(n))).length,
      unmatched: names.filter((n) => !resourceKeys.has(nameKey(n))).sort((a, b) => a.localeCompare(b)),
    },
    resources: {
      total: resources.length,
      matched: resources.length - unmatched.length,
      priced: resources.filter((r) => trade.has(r.uuid)).length,
      unmatched: unmatched.map(({ uuid, name, isOre }) => ({ uuid, name, isOre })).sort((a, b) => a.name.localeCompare(b.name)),
    },
    items: { priced: items.filter((i) => trade.has(i.uuid)).length, gear: gear.length, gearPriced: gear.filter((i) => trade.has(i.uuid)).length },
  };
}

/** UEX's method ratings and the community values (ext.refining_method), one row per code. */
async function joinMethods(db: Db, lang: string, uex: Record<string, unknown>[]): Promise<UexMethod[]> {
  const byCode = new Map<string, UexMethod>();
  for (const m of await refiningMethods(db, lang)) {
    byCode.set(m.code, {
      name: m.name, code: m.code, ratingYield: null, ratingCost: null, ratingSpeed: null,
      yieldPct: m.yieldPct, secondsPerScu: m.secondsPerScu, source: `${m.source} · ${m.gameVersion}`,
    });
  }
  for (const m of uex) {
    const code = String(m.code);
    const row = byCode.get(code) ?? { name: String(m.name), code, ratingYield: null, ratingCost: null, ratingSpeed: null, yieldPct: null, secondsPerScu: null, source: null };
    byCode.set(code, { ...row, ratingYield: Number(m.rating_yield), ratingCost: Number(m.rating_cost), ratingSpeed: Number(m.rating_speed) });
  }
  return [...byCode.values()].sort((a, b) => (b.yieldPct ?? -1) - (a.yieldPct ?? -1) || a.name.localeCompare(b.name));
}
