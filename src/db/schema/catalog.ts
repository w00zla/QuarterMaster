// Game catalog, global for all guilds. Written only by the catalog and localization import CLIs.
// Catalog rows are never deleted: entries missing from a newer snapshot get `retired_at`.
import { sql } from 'drizzle-orm';
import {
  boolean, check, foreignKey, index, integer, jsonb, numeric, pgSchema, primaryKey, serial, text, timestamp, uuid,
} from 'drizzle-orm/pg-core';

export const catalog = pgSchema('catalog');

export const importRun = catalog.table('import', {
  id: serial('id').primaryKey(),
  channel: text('channel').notNull(),
  gameBuild: integer('game_build').notNull(),
  gameBranch: text('game_branch').notNull(),
  gameVersion: text('game_version').notNull(),
  gameLabel: text('game_label'),
  manifest: jsonb('manifest'),
  schemaVersion: integer('schema_version').notNull(),
  snapshotSha256: text('snapshot_sha256').notNull(),
  extractorVersion: text('extractor_version').notNull(),
  starbreakerVersion: text('starbreaker_version').notNull(),
  extractedAt: timestamp('extracted_at', { withTimezone: true }).notNull(),
  importedAt: timestamp('imported_at', { withTimezone: true }).notNull().defaultNow(),
  forced: boolean('forced').notNull().default(false),
  summary: jsonb('summary'),
  anomalies: jsonb('anomalies'),
});

/** Columns shared by every catalog entity. */
const lifecycle = () => ({
  // Hash of the entity as delivered by the snapshot; drives change detection
  contentHash: text('content_hash').notNull(),
  firstSeenImportId: integer('first_seen_import_id').notNull().references(() => importRun.id),
  lastSeenImportId: integer('last_seen_import_id').notNull().references(() => importRun.id),
  retiredAt: timestamp('retired_at', { withTimezone: true }),
});

/** Unmodified DataCore records everything else is derived from. */
export const rawRecord = catalog.table('raw_record', {
  uuid: uuid('uuid').primaryKey(),
  name: text('name').notNull(),
  type: text('type').notNull(),
  path: text('path').notNull(),
  data: jsonb('data').notNull(),
  ...lifecycle(),
}, (t) => [index().on(t.type)]);

export const resource = catalog.table('resource', {
  uuid: uuid('uuid').primaryKey(),
  key: text('key').notNull(),
  groupPath: text('group_path').array().notNull(),
  nameKey: text('name_key'),
  descriptionKey: text('description_key'),
  isOre: boolean('is_ore').notNull(),
  refinedUuid: uuid('refined_uuid'),
  densityGPerCc: numeric('density_g_per_cc'),
  boxSizesScu: numeric('box_sizes_scu').array().notNull(),
  craftingData: jsonb('crafting_data').notNull(),
  data: jsonb('data').notNull(),
  ...lifecycle(),
}, (t) => [index().on(t.key)]);

export const manufacturer = catalog.table('manufacturer', {
  uuid: uuid('uuid').primaryKey(),
  key: text('key').notNull(),
  code: text('code'),
  nameKey: text('name_key'),
  descriptionKey: text('description_key'),
  ...lifecycle(),
});

export const item = catalog.table('item', {
  uuid: uuid('uuid').primaryKey(),
  className: text('class_name').notNull(),
  type: text('type'),
  subType: text('sub_type'),
  size: integer('size'),
  grade: integer('grade'),
  manufacturerUuid: uuid('manufacturer_uuid').references(() => manufacturer.uuid),
  nameKey: text('name_key'),
  descriptionKey: text('description_key'),
  ...lifecycle(),
}, (t) => [index().on(t.className)]);

export const blueprintCategory = catalog.table('blueprint_category', {
  uuid: uuid('uuid').primaryKey(),
  key: text('key').notNull(),
  ...lifecycle(),
});

export const craftedProperty = catalog.table('crafted_property', {
  uuid: uuid('uuid').primaryKey(),
  key: text('key').notNull(),
  nameKey: text('name_key'),
  unitKey: text('unit_key'),
  displayTransformation: jsonb('display_transformation'),
  ...lifecycle(),
});

/** Quality bands per material (not used by the app yet). */
export const qualityQuantization = catalog.table('quality_quantization', {
  uuid: uuid('uuid').primaryKey(),
  key: text('key').notNull(),
  bands: jsonb('bands').notNull(),
  ...lifecycle(),
});

export const blueprint = catalog.table('blueprint', {
  uuid: uuid('uuid').primaryKey(),
  key: text('key').notNull(),
  categoryUuid: uuid('category_uuid').references(() => blueprintCategory.uuid),
  outputItemUuid: uuid('output_item_uuid').references(() => item.uuid),
  isDefault: boolean('is_default').notNull(),
  ...lifecycle(),
}, (t) => [index().on(t.key), index().on(t.outputItemUuid)]);

// Recipe tables below are replaced as a whole whenever their blueprint changes.

export const blueprintTier = catalog.table('blueprint_tier', {
  blueprintUuid: uuid('blueprint_uuid').notNull().references(() => blueprint.uuid),
  tierIndex: integer('tier_index').notNull(),
  craftSeconds: numeric('craft_seconds').notNull(),
  // How many of the tier's slots must be filled
  requiredSlots: integer('required_slots').notNull(),
}, (t) => [primaryKey({ columns: [t.blueprintUuid, t.tierIndex] })]);

export const blueprintSlot = catalog.table('blueprint_slot', {
  blueprintUuid: uuid('blueprint_uuid').notNull().references(() => blueprint.uuid),
  tierIndex: integer('tier_index').notNull(),
  slotIndex: integer('slot_index').notNull(),
  key: text('key').notNull(),
  nameKey: text('name_key'),
  requiredCount: integer('required_count').notNull(),
  // [{ propertyUuid, ranges: [{ type, startQuality, endQuality, values }] }]
  modifiers: jsonb('modifiers').notNull(),
}, (t) => [primaryKey({ columns: [t.blueprintUuid, t.tierIndex, t.slotIndex] })]);

export const blueprintInput = catalog.table('blueprint_input', {
  blueprintUuid: uuid('blueprint_uuid').notNull().references(() => blueprint.uuid),
  tierIndex: integer('tier_index').notNull(),
  slotIndex: integer('slot_index').notNull(),
  inputIndex: integer('input_index').notNull(),
  kind: text('kind').notNull(),
  resourceUuid: uuid('resource_uuid').references(() => resource.uuid),
  itemUuid: uuid('item_uuid').references(() => item.uuid),
  // resource: SCU, item: count
  quantity: numeric('quantity').notNull(),
  minQuality: integer('min_quality').notNull(),
}, (t) => [
  primaryKey({ columns: [t.blueprintUuid, t.tierIndex, t.slotIndex, t.inputIndex] }),
  index().on(t.resourceUuid),
  index().on(t.itemUuid),
  check('blueprint_input_kind', sql`(${t.kind} = 'resource' AND ${t.resourceUuid} IS NOT NULL AND ${t.itemUuid} IS NULL)
    OR (${t.kind} = 'item' AND ${t.itemUuid} IS NOT NULL AND ${t.resourceUuid} IS NULL)`),
]);

/**
 * One text set per source and language: 'game' (catalog import) or an externally maintained
 * global.ini (localization import). The source with the highest priority wins per key.
 */
export const localizationSource = catalog.table('localization_source', {
  source: text('source').notNull(),
  lang: text('lang').notNull(),
  priority: integer('priority').notNull(),
  // Snapshot build or file the texts came from
  origin: text('origin').notNull(),
  contentSha256: text('content_sha256').notNull(),
  keyCount: integer('key_count').notNull(),
  importedAt: timestamp('imported_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [primaryKey({ columns: [t.source, t.lang] })]);

export const localization = catalog.table('localization', {
  source: text('source').notNull(),
  lang: text('lang').notNull(),
  key: text('key').notNull(),
  value: text('value').notNull(),
}, (t) => [
  primaryKey({ columns: [t.source, t.lang, t.key] }),
  foreignKey({ columns: [t.source, t.lang], foreignColumns: [localizationSource.source, localizationSource.lang] }).onDelete('cascade'),
  index().on(t.lang, t.key),
]);

/** Effective text per language and key: highest priority source wins. */
export const localizationEffective = catalog.view('localization_effective', {
  lang: text('lang').notNull(),
  key: text('key').notNull(),
  value: text('value').notNull(),
  source: text('source').notNull(),
}).as(sql`
  SELECT DISTINCT ON (l.lang, l.key) l.lang, l.key, l.value, l.source
  FROM ${localization} l
  JOIN ${localizationSource} s ON s.source = l.source AND s.lang = l.lang
  ORDER BY l.lang, l.key, s.priority DESC, l.source`);
