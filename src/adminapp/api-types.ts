// Response types of the admin API, shared by the server (src/adminapp) and the SPA (adminapp/).
// Types only: the SPA imports this file and must not pull in server dependencies.

export interface GameInfo {
  channel: string;
  build: number;
  label: string | null;
  branch: string;
  importId: number;
  importedAt: string;
}

export interface Meta {
  game: GameInfo | null;
  // Languages with texts, game languages first
  langs: string[];
}

export interface EntityCount {
  entity: string;
  active: number;
  retired: number;
}

export interface ImportRow {
  id: number;
  channel: string;
  gameBuild: number;
  gameLabel: string | null;
  importedAt: string;
  forced: boolean;
  anomalyCount: number;
}

export interface Anomaly {
  code: string;
  record: string | null;
  detail: string;
}

export interface ImportDetail extends ImportRow {
  gameBranch: string;
  gameVersion: string;
  snapshotSha256: string;
  extractorVersion: string;
  starbreakerVersion: string;
  extractedAt: string;
  summary: unknown;
  anomalies: Anomaly[];
}

export interface LocSource {
  source: string;
  lang: string;
  priority: number;
  origin: string;
  keyCount: number;
  importedAt: string;
}

/** One text source over all its languages. */
export interface SourceSummary {
  source: string;
  langs: string[];
  minPriority: number;
  maxPriority: number;
  keyCount: number;
}

export interface Overview {
  // Sorted by active count, largest first
  counts: EntityCount[];
  imports: ImportRow[];
  // Sorted by priority, highest first
  sources: SourceSummary[];
  // Active blueprints per category group, most first
  categories: { group: string; label: string; count: number }[];
  // Materials used by the most active recipes
  topMaterials: { kind: 'resource' | 'item'; uuid: string; name: string; recipes: number }[];
  facts: {
    defaultBlueprints: number;
    // Recipes with at least one input that requires a minimum quality above 1
    qualityGated: number;
    // Recipes where only some slots must be filled
    slotChoice: number;
    resourcesInRecipes: number;
    itemsInRecipes: number;
    avgCraftSeconds: number | null;
    longestCraft: { uuid: string; name: string; seconds: number } | null;
    // Catalog changes of the latest import (blueprints)
    lastImport: { id: number; added: number; changed: number; retired: number; revived: number } | null;
  };
  gaps: {
    // Texts per kind of name: none in the requested language (falls back) / none at all
    lang: string;
    texts: { entity: string; total: number; missingInLang: number; missingEverywhere: number }[];
    // Neither default nor in any reward pool of the game data
    noSourceBlueprints: number;
    noOutputBlueprints: number;
    // Resources no active recipe uses, and how many of them are ores
    unusedResources: number;
    unusedOres: number;
  };
}

export interface Lifecycle {
  firstSeenImportId: number;
  lastSeenImportId: number;
  retiredAt: string | null;
}

export interface BlueprintRow {
  uuid: string;
  key: string;
  name: string;
  outputClass: string | null;
  outputType: string | null;
  outputSubType: string | null;
  // Display names (game texts, else derived)
  outputTypeLabel: string | null;
  outputSubTypeLabel: string | null;
  size: number | null;
  grade: number | null;
  // As the game shows them (from the description); null where the game has none
  gradeLetter: string | null;
  itemClass: string | null;
  manufacturer: string | null;
  // Technical key, its group (without size) and the group's display name (app text, else derived)
  category: string | null;
  categoryGroup: string | null;
  categoryLabel: string | null;
  isDefault: boolean;
  craftSeconds: number | null;
  slotCount: number;
  retired: boolean;
}

export interface Ref {
  uuid: string;
  key: string;
  name: string;
}

export interface BlueprintInput extends Ref {
  kind: 'resource' | 'item';
  // SCU for resources, count for items (decimal string)
  quantity: string;
  minQuality: number;
}

export interface BlueprintModifier {
  property: { uuid: string; key: string; name: string | null; unit: string | null } | null;
  propertyUuid: string;
  ranges: { type: string; startQuality: number; endQuality: number; values: Record<string, number> }[];
}

export interface BlueprintSlot {
  index: number;
  key: string;
  name: string | null;
  requiredCount: number;
  modifiers: BlueprintModifier[];
  inputs: BlueprintInput[];
}

export interface BlueprintTier {
  index: number;
  craftSeconds: number;
  requiredSlots: number;
  slots: BlueprintSlot[];
}

export interface BlueprintDetail extends Lifecycle {
  uuid: string;
  key: string;
  name: string;
  isDefault: boolean;
  category: string | null;
  categoryGroup: string | null;
  categoryLabel: string | null;
  output: (Ref & {
    className: string; type: string | null; subType: string | null; typeLabel: string | null; subTypeLabel: string | null;
    size: number | null; grade: number | null; gradeLetter: string | null; itemClass: string | null; manufacturer: string | null;
  }) | null;
  tiers: BlueprintTier[];
  raw: unknown;
}

export interface ResourceRow {
  uuid: string;
  key: string;
  name: string;
  group: string;
  isOre: boolean;
  boxSizes: string[];
  usedIn: number;
  retired: boolean;
}

export interface QualityBand {
  start: number;
  end: number;
  mappedValue: number;
}

export interface ResourceDetail extends Lifecycle {
  uuid: string;
  key: string;
  name: string;
  description: string | null;
  groupPath: string[];
  isOre: boolean;
  densityGPerCc: string | null;
  boxSizes: string[];
  refined: Ref | null;
  ores: Ref[];
  qualityBands: QualityBand[] | null;
  usedBy: (Ref & { quantity: string; minQuality: number; slot: string })[];
  raw: unknown;
}

export interface ItemRow {
  uuid: string;
  className: string;
  name: string;
  type: string | null;
  subType: string | null;
  typeLabel: string | null;
  subTypeLabel: string | null;
  size: number | null;
  grade: number | null;
  gradeLetter: string | null;
  itemClass: string | null;
  manufacturer: string | null;
  asOutput: number;
  asInput: number;
  retired: boolean;
}

export interface ItemDetail extends Lifecycle {
  uuid: string;
  className: string;
  name: string;
  description: string | null;
  type: string | null;
  subType: string | null;
  typeLabel: string | null;
  subTypeLabel: string | null;
  size: number | null;
  grade: number | null;
  gradeLetter: string | null;
  itemClass: string | null;
  manufacturer: { code: string | null; name: string | null } | null;
  outputOf: Ref[];
  inputOf: (Ref & { quantity: string; minQuality: number; slot: string })[];
  raw: unknown;
}

export interface LocSearchRow {
  key: string;
  value: string;
  source: string;
}

export interface LocSearch {
  total: number;
  rows: LocSearchRow[];
}

export interface LocKeyValue {
  lang: string;
  source: string;
  priority: number;
  value: string;
  effective: boolean;
}

export interface EntityCounts { total: number; added: number; changed: number; unchanged: number; revived: number; retired: number }
export interface TextCounts { total: number; added: number; changed: number; unchanged: number; removed: number }
export interface Violation { code: string; message: string; override: string }

/** Result of a catalog import from the web UI (dry run or real). */
export interface CatalogImportResponse {
  status: 'imported' | 'dry-run' | 'noop' | 'blocked';
  importId: number | null;
  game: { channel: string; build: number; branch: string; version: string; label: string | null };
  extractedAt: string;
  snapshotSha256: string;
  anomalyCount: number;
  lastImport: { id: number; channel: string; gameBuild: number } | null;
  entities: Record<string, EntityCounts>;
  localization: Record<string, TextCounts>;
  violations: Violation[];
  warnings: string[];
}

/** Result of a localization import from the web UI (dry run or real). */
export interface LocImportResponse {
  status: 'imported' | 'dry-run' | 'noop' | 'blocked';
  source: string;
  lang: string;
  priority: number;
  previous: { priority: number; keyCount: number; importedAt: string } | null;
  file: { keys: number; placeholders: number; appKeys: number };
  texts: TextCounts;
  knownToGame: number | null;
  gameKeys: number | null;
  wins: number | null;
  violations: Violation[];
  warnings: string[];
}

export interface LocKeyDetail {
  key: string;
  values: LocKeyValue[];
}

// --- 3rd party: UEX ----------------------------------------------------------------------------

/** The latest snapshot of one pulled UEX endpoint. */
export interface UexEndpointStatus {
  endpoint: string;
  rows: number;
  // Distinct responses kept (the history)
  snapshots: number;
  // First fetch with the latest content / latest fetch that returned it
  changedAt: string;
  checkedAt: string;
}

export interface UexRefinery {
  terminalId: number;
  terminal: string;
  system: string;
  // UEX's station/city name
  place: string;
  // Matched catalog location (label in the text language); null = not matched
  locationUuid: string | null;
  location: string | null;
  // Yield bonus in % per ore (UEX's ore name)
  yields: Record<string, number>;
}

export interface UexMethod {
  name: string;
  code: string;
  // UEX ratings 1 (low) to 3 (high)
  ratingYield: number;
  ratingCost: number;
  ratingSpeed: number;
}

export interface UexResponse {
  endpoints: UexEndpointStatus[];
  refineries: UexRefinery[];
  // Every ore that appears in the yields, alphabetical
  ores: string[];
  methods: UexMethod[];
}
