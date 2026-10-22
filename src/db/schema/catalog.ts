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
  // From the English description: only ship components have a grade letter (A–D)
  gradeLetter: text('grade_letter'),
  // English class name (Military, …); display names are app texts qm_item_class_<lower>
  itemClass: text('item_class'),
  manufacturerUuid: uuid('manufacturer_uuid').references(() => manufacturer.uuid),
  nameKey: text('name_key'),
  descriptionKey: text('description_key'),
  ...lifecycle(),
  // The "plain part" check of gear (componentItemSql) looks up items by type and name
}, (t) => [index().on(t.className), index().on(t.type, t.nameKey)]);

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
 * Where a blueprint comes from (snapshot `blueprintSources`): a contract handing out a reward pool with it
 * ('mission') or a point tier of an event ('event'). Derived data: replaced as a whole on every import.
 */
export const blueprintSource = catalog.table('blueprint_source', {
  blueprintUuid: uuid('blueprint_uuid').notNull().references(() => blueprint.uuid),
  sourceIndex: integer('source_index').notNull(),
  kind: text('kind').notNull(),
  poolUuid: uuid('pool_uuid').notNull(),
  poolKey: text('pool_key').notNull(),
  // This blueprint's weight of the pool's total: the game picks one entry by weight
  weight: numeric('weight').notNull(),
  poolWeight: numeric('pool_weight').notNull(),
  contractId: uuid('contract_id'),
  contractKey: text('contract_key'),
  titleKey: text('title_key'),
  missionTypeKey: text('mission_type_key'),
  factionUuid: uuid('faction_uuid'),
  factionNameKey: text('faction_name_key'),
  minRankNameKey: text('min_rank_name_key'),
  minReputation: numeric('min_reputation'),
  // Star map objects (catalog.location, no foreign key like parent_uuid): where the contract is offered
  // (its locality, systems follow from the parents), the location it is bound to
  localityUuids: uuid('locality_uuids').array().notNull(),
  locationUuids: uuid('location_uuids').array().notNull(),
  requiresPrevious: boolean('requires_previous').notNull(),
  illegal: boolean('illegal').notNull(),
  chance: numeric('chance'),
  onAccept: boolean('on_accept').notNull(),
  eventKey: text('event_key'),
  minPoints: integer('min_points'),
}, (t) => [
  primaryKey({ columns: [t.blueprintUuid, t.sourceIndex] }),
  check('blueprint_source_kind', sql`${t.kind} IN ('mission', 'event')`),
]);

/** Star map objects (systems, planets, stations, outposts, …), all of them; the app selects what it offers. */
export const location = catalog.table('location', {
  uuid: uuid('uuid').primaryKey(),
  key: text('key').notNull(),
  nameKey: text('name_key'),
  descriptionKey: text('description_key'),
  // No foreign key: rows of one import reference each other in any order (checked by the import instead)
  parentUuid: uuid('parent_uuid'),
  // StarMapObjectType name ("Planet", "Manmade", …)
  type: text('type'),
  // Marker icon ("Station", "LandingZone", "Outpost", …)
  navIcon: text('nav_icon'),
  hideInStarmap: boolean('hide_in_starmap').notNull(),
  respawnLocationType: text('respawn_location_type'),
  ...lifecycle(),
}, (t) => [index().on(t.parentUuid), index().on(t.navIcon)]);

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
