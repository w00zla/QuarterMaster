// Catalog snapshot: the contract between extractor and importer.
// Bump SNAPSHOT_SCHEMA_VERSION on any incompatible change.
import { z } from 'zod';

export const SNAPSHOT_SCHEMA_VERSION = 8;

// Game record ids are UUID-shaped but not necessarily RFC-compliant
const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
const locKey = z.string().nullable();

export const anomalySchema = z.object({
  code: z.string(),
  record: z.string().nullable(),
  detail: z.string(),
});

export const rawRecordSchema = z.object({
  uuid,
  name: z.string(),
  type: z.string(),
  path: z.string(),
  data: z.unknown(),
});

export const resourceSchema = z.object({
  uuid,
  key: z.string(),
  groupPath: z.array(z.string()),
  nameKey: locKey,
  descriptionKey: locKey,
  isOre: z.boolean(),
  refinedUuid: uuid.nullable(),
  densityGPerCc: z.number().nullable(),
  boxSizesScu: z.array(z.number()),
  craftingData: z.array(z.object({
    name: z.string().nullable(),
    qualityDistributionUuid: uuid.nullable(),
    qualityLocationOverrideUuid: uuid.nullable(),
    qualityQuantizationUuid: uuid.nullable(),
  })),
  data: z.unknown(),
});

export const manufacturerSchema = z.object({
  uuid,
  key: z.string(),
  code: z.string().nullable(),
  nameKey: locKey,
  descriptionKey: locKey,
});

export const itemSchema = z.object({
  uuid,
  className: z.string(),
  type: z.string().nullable(),
  subType: z.string().nullable(),
  size: z.number().int().nullable(),
  grade: z.number().int().nullable(),
  // As the game states them in the English description ("Grade: B", "Class: Military"); the
  // numeric grade is set on every item, but only ship components have a grade in the game
  gradeLetter: z.string().nullable(),
  itemClass: z.string().nullable(),
  manufacturerUuid: uuid.nullable(),
  nameKey: locKey,
  descriptionKey: locKey,
  // A shop item (components.ts SHOP_TYPES): catalog-only, stored without a raw record
  shop: z.boolean(),
  // Harvestables: SCU one piece takes in an inventory (null: none or not a harvestable)
  scuPerPiece: z.number().nullable(),
  // Crafted property key -> the unmodified value as the game's tooltip shows it, for every property the
  // item's record holds one for (src/stock/component-base.ts)
  baseStats: z.record(z.string(), z.number()),
});

export const blueprintCategorySchema = z.object({
  uuid,
  key: z.string(),
});

export const craftedPropertySchema = z.object({
  uuid,
  key: z.string(),
  nameKey: locKey,
  unitKey: locKey,
  // e.g. { _Type_: 'CraftingDisplayTransformation_Scale', scale: 0.000001 }; several types exist
  displayTransformation: z.unknown(),
});

export const qualityQuantizationSchema = z.object({
  uuid,
  key: z.string(),
  bands: z.array(z.object({ start: z.number(), end: z.number(), mappedValue: z.number() })),
});

export const modifierRangeSchema = z.object({
  type: z.string(),
  startQuality: z.number(),
  endQuality: z.number(),
  // Linear: modifierAtStart/End; LinearIntegerAdditive: additiveModifierAtStart/End; unknown types keep their raw numbers
  values: z.record(z.string(), z.number()),
});

export const blueprintInputSchema = z.object({
  kind: z.enum(['resource', 'item']),
  uuid,
  // resource: SCU; item: count
  quantity: z.number(),
  minQuality: z.number().int(),
});

export const blueprintSlotSchema = z.object({
  key: z.string(),
  nameKey: locKey,
  requiredCount: z.number().int(),
  modifiers: z.array(z.object({ propertyUuid: uuid, ranges: z.array(modifierRangeSchema) })),
  inputs: z.array(blueprintInputSchema),
});

export const blueprintTierSchema = z.object({
  craftSeconds: z.number(),
  // How many of the slots must be filled (usually all of them)
  requiredSlots: z.number().int(),
  slots: z.array(blueprintSlotSchema),
});

export const blueprintSchema = z.object({
  uuid,
  key: z.string(),
  categoryUuid: uuid.nullable(),
  outputItemUuid: uuid.nullable(),
  isDefault: z.boolean(),
  // Some blueprint reward pool hands it out
  inRewardPool: z.boolean(),
  tiers: z.array(blueprintTierSchema),
});

// Where a blueprint comes from: a contract hands out a reward pool holding it ('mission'), or a point tier
// of an event's progress does ('event'). One entry per blueprint, contract (or tier) and pool.
export const blueprintSourceSchema = z.object({
  blueprintUuid: uuid,
  kind: z.enum(['mission', 'event']),
  poolUuid: uuid,
  poolKey: z.string(),
  // The game picks one entry of the pool by weight: this blueprint's weight of the pool's total
  weight: z.number(),
  poolWeight: z.number(),
  // Mission: the contract (id within its generator record, debug name), its texts and conditions
  contractId: uuid.nullable(),
  contractKey: z.string().nullable(),
  titleKey: locKey,
  missionTypeKey: locKey,
  factionUuid: uuid.nullable(),
  factionNameKey: locKey,
  // Minimum standing with the faction: its rank name and reputation points (0 = none)
  minRankNameKey: locKey,
  minReputation: z.number().nullable(),
  // Star map objects the contract is offered at (its locality: systems, planets, stations, … as the game
  // lists them; the system follows from their parents) and, if bound to one, the location
  localityUuids: z.array(uuid),
  locationUuids: z.array(uuid),
  // Needs a completed earlier contract (a mission chain)
  requiresPrevious: z.boolean(),
  illegal: z.boolean(),
  // Share of completions that hand out the pool (1 = always)
  chance: z.number().nullable(),
  // Handed out on accepting the contract, not on completing it
  onAccept: z.boolean(),
  // Event: the scenario ("RoX", "ORS"; missions only when their scenario is started by hand) and the tier
  eventKey: z.string().nullable(),
  minPoints: z.number().nullable(),
});

// Star map object (system, planet, station, outpost, …); all of them, selection happens in the app
export const locationSchema = z.object({
  uuid,
  key: z.string(),
  nameKey: locKey,
  descriptionKey: locKey,
  parentUuid: uuid.nullable(),
  // StarMapObjectType name, e.g. "Planet", "Manmade", "LandingZone"
  type: z.string().nullable(),
  // Marker icon, e.g. "Station", "LandingZone", "Outpost", "Default"
  navIcon: z.string().nullable(),
  hideInStarmap: z.boolean(),
  respawnLocationType: z.string().nullable(),
  // The record lists the amenity "Commodity Trading - Freight Elevator"
  freightElevator: z.boolean(),
  // A refinery is here (not filled yet: false)
  refinery: z.boolean(),
});

// What can be mined where: a harvestable provider preset (the spawn table of a planet, moon or asteroid
// field) and the star map objects whose object containers use it
export const miningProviderSchema = z.object({
  uuid,
  key: z.string(),
  locationUuids: z.array(uuid),
});

// One part of a resource at one provider and mining method: the share of the method's rocks there that hold
// it, how much of such a rock it is, and the quality it spawns with in the provider's system. A rock holds an
// ore as a small rich part (qualityScale 1) and a large lean one (0.49, 0.789): one entry each.
export const mineableSchema = z.object({
  providerUuid: uuid,
  method: z.enum(['ship', 'roc', 'fps']),
  resourceUuid: uuid,
  // The part's quality factor
  qualityScale: z.number(),
  // The item the rock breaks into (FPS and ROC gems: recipes take the item, not the resource)
  itemUuid: uuid.nullable(),
  // 0–1 of the method's rocks at the provider holding the part (the rocks' weight times the part's chance)
  share: z.number(),
  // Percent of such a rock
  minPercent: z.number(),
  maxPercent: z.number(),
  // From the rock composition's name (common … legendary); ship rocks only
  rarity: z.string().nullable(),
  // The quality the part spawns with (the resource's distribution, the system's override, times the factor):
  // its range and the values the material's quality bands map it to, with their chances (empty without bands)
  quality: z.object({
    min: z.number(), max: z.number(), values: z.array(z.object({ value: z.number(), chance: z.number() })),
  }).nullable(),
});

// A rock kind the placed providers spawn (entities/mineable/<rock>), per mining method: the resource it is
// named after (its composition's first part), its rarity and its radar signature (one node; the scanner shows it
// times the cluster's nodes)
export const mineableRockSchema = z.object({
  uuid,
  key: z.string(),
  method: z.enum(['ship', 'roc', 'fps']),
  resourceUuid: uuid,
  // From the rock composition's name (common … legendary); ship rocks only
  rarity: z.string().nullable(),
  radarSignature: z.number().nullable(),
});

export const snapshotSchema = z.object({
  schemaVersion: z.literal(SNAPSHOT_SCHEMA_VERSION),
  game: z.object({
    channel: z.string(),
    build: z.number().int(),
    branch: z.string(),
    version: z.string(),
    label: z.string().nullable(),
    manifest: z.unknown(),
  }),
  extractor: z.object({ version: z.string(), starbreaker: z.string() }),
  extractedAt: z.iso.datetime(),
  // Crafting rules of the game (CraftingGlobalParams); null: the record is missing
  crafting: z.object({ defaultCompositionQuality: z.number().int().nullable() }),
  anomalies: z.array(anomalySchema),
  // Language code -> loc key (lower case, without '@') -> text; complete global.ini per shipped language
  localization: z.record(z.string(), z.record(z.string(), z.string())),
  // Absent = none: the data pack's slim snapshot (docs/singleuser.md) leaves them out
  rawRecords: z.array(rawRecordSchema).default([]),
  resources: z.array(resourceSchema),
  manufacturers: z.array(manufacturerSchema),
  items: z.array(itemSchema),
  blueprintCategories: z.array(blueprintCategorySchema),
  craftedProperties: z.array(craftedPropertySchema),
  qualityQuantizations: z.array(qualityQuantizationSchema),
  blueprints: z.array(blueprintSchema),
  blueprintSources: z.array(blueprintSourceSchema),
  locations: z.array(locationSchema),
  miningProviders: z.array(miningProviderSchema),
  mineables: z.array(mineableSchema),
  mineableRocks: z.array(mineableRockSchema),
});

export type Snapshot = z.infer<typeof snapshotSchema>;
export type Anomaly = z.infer<typeof anomalySchema>;
export type RawRecord = z.infer<typeof rawRecordSchema>;
export type Resource = z.infer<typeof resourceSchema>;
export type Manufacturer = z.infer<typeof manufacturerSchema>;
export type Item = z.infer<typeof itemSchema>;
export type BlueprintCategory = z.infer<typeof blueprintCategorySchema>;
export type CraftedProperty = z.infer<typeof craftedPropertySchema>;
export type QualityQuantization = z.infer<typeof qualityQuantizationSchema>;
export type Blueprint = z.infer<typeof blueprintSchema>;
export type BlueprintSource = z.infer<typeof blueprintSourceSchema>;
export type Location = z.infer<typeof locationSchema>;
export type MiningProvider = z.infer<typeof miningProviderSchema>;
export type Mineable = z.infer<typeof mineableSchema>;
export type MineableRock = z.infer<typeof mineableRockSchema>;
export type BlueprintTier = z.infer<typeof blueprintTierSchema>;
export type BlueprintSlot = z.infer<typeof blueprintSlotSchema>;
export type BlueprintInput = z.infer<typeof blueprintInputSchema>;
export type ModifierRange = z.infer<typeof modifierRangeSchema>;
