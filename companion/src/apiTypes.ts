// The Quartermaster web app's API types the companion uses (copied from sc-quartermaster's
// src/webapp/api-types.ts, only what the companion reads or sends). Pure types.

export interface MeOrg {
  guildId: string;
  name: string;
  // The user's name on that server (roster)
  displayName: string;
}

export interface MeResponse {
  userId: string;
  // Discord display name (global name, else username) and username, as of the last login
  name: string;
  username: string;
  avatarUrl: string;
  // Active memberships only
  orgs: MeOrg[];
  // Star Citizen account name, shown to the user's orgs; null = not set
  rsiHandle: string | null;
  // The web app's language override (the bot keeps its own); null = follow the browser
  langOverride: Lang | null;
  // Privilege keys in force (`<feature>.<right>`, sc-quartermaster's docs/webapp.md "Features and privileges"): what this user may
  // do in the features beyond the roles
  privileges: string[];
}

export type Lang = 'de' | 'en';

// --- catalog (GET /api/catalog?lang=de|en) -------------------------------------------------------
// Everything the pickers need, in the requested language; filter and search in the browser.

export interface CatalogMaterial {
  uuid: string;
  kind: 'resource' | 'item';
  name: string;
  // The game's localization key of the name (lower case): the companion app looks it up in the player's language pack
  nameKey: string | null;
  // SCU for resources, pieces for items
  unit: 'SCU' | 'pcs';
  // Items: the item type (for its icon) and its display name; null for resources
  type: string | null;
  typeLabel: string | null;
  // A ship component (an item without quality: booked with quality 0, its own view)
  component: boolean;
  // Components: unique display label ("Name · Cooler · S3 · B Industrial"); else the name
  label: string;
  // Items: size, grade letter and class where the game has them
  size: number | null;
  gradeLetter: string | null;
  itemClass: string | null;
  // Components: the stats a batch can carry, in the game tooltip's order; else none
  stats: CatalogStat[];
  // The game data says where it is mined (GET /api/mining/:uuid)
  minable: boolean;
  // Its thumbnail's hash (the server's thumbnail path, src/thumbs.ts here); null = none, show the type icon
  thumb: string | null;
}

export interface CatalogStat {
  // The crafted property (the key in StockBatch.stats and StockAddRequest.stats)
  uuid: string;
  // As the game names it ("Coolant Rating")
  name: string;
  // The game's localization key of that name (lower case): the companion looks it up in the player's language pack
  nameKey: string | null;
  // What the blueprint can make of it, like the crafting check shows it: a multiplier as its change in
  // percent (min/max e.g. -19.3/20.8, one decimal), additive steps as whole numbers (power pips, e.g. -2/2)
  kind: 'multiplier' | 'additive';
  min: number;
  max: number;
  // The unmodified value as the game's tooltip shows it ("Coolant Rating: 60.00" -> 60); null when the
  // app does not know where the record keeps it (the companion then reads no stats off such a tooltip)
  base: number | null;
  // How the tooltip shows it: its value (converted with `base`) or its change in percent, negated for
  // some ("Recoil Smoothness: +28.44 %" for a stored -28.4; sc-quartermaster's src/stock/component-base.ts)
  tooltip: 'value' | 'change' | 'negatedChange';
}

export interface CatalogLocation {
  uuid: string;
  // The star map record's key ("RR_CRU_LEO"), as Game.log names the player's location (the companion)
  key: string;
  // "Area18 · ArcCorp · Stanton"
  label: string;
  // "Area18", plus the system where the name alone is ambiguous
  short: string;
  // The game's localization key of the name (lower case), as for materials
  nameKey: string | null;
  // Has a refinery (per UEX; every location while there is no UEX data yet)
  refinery: boolean;
  // Refinery yield bonus in % per refined material UUID (per UEX, reported per ore; only those UEX reports for this refinery)
  yields: Record<string, number>;
}

export interface CatalogBlueprint {
  uuid: string;
  // Unique display label ("Name · S3 · B Industrial · CHCO")
  label: string;
  // The output's name and properties, for table columns; type = the output item's type (icon)
  name: string;
  type: string | null;
  typeLabel: string | null;
  size: number | null;
  gradeLetter: string | null;
  itemClass: string | null;
  manufacturerCode: string | null;
  // Category group label for grouping lists, null = other
  category: string | null;
  // Everyone has it: never registered
  isDefault: boolean;
  retired: boolean;
  // Names of the stats its slots can change, in the game tooltip's order; empty when none
  stats: string[];
  // The game data has a source for it (GET /api/unlocks/:uuid)
  unlockable: boolean;
  // The item it crafts and that item's thumbnail hash (as CatalogMaterial.thumb); null = none
  outputUuid: string | null;
  thumb: string | null;
}

// --- the companion app's catalog (GET /api/companion/catalog?lang=de|en) ---------------------------
// The rows of GET /api/catalog with only the fields the companion reads (the unit follows from `kind`);
// cached the same way (ETag, revalidated).

export type CompanionCatalogMaterial = Pick<CatalogMaterial,
  'uuid' | 'kind' | 'name' | 'nameKey' | 'type' | 'typeLabel' | 'component' | 'label' | 'size' | 'gradeLetter' | 'stats' | 'thumb'>;
export type CompanionCatalogLocation = Pick<CatalogLocation, 'uuid' | 'key' | 'label' | 'short' | 'nameKey' | 'refinery'>;
export type CompanionCatalogBlueprint = Pick<CatalogBlueprint,
  'uuid' | 'label' | 'name' | 'size' | 'gradeLetter' | 'isDefault' | 'retired' | 'outputUuid' | 'thumb'>;

export interface CompanionCatalogResponse {
  materials: CompanionCatalogMaterial[];
  locations: CompanionCatalogLocation[];
  blueprints: CompanionCatalogBlueprint[];
}

// --- stock -------------------------------------------------------------------------------------
// All take &lang=de|en for material and location names and answer StockListResponse.
// GET /api/stock?scope=personal                       your personal stock (incl. refinery jobs: state 'refining', not stock yet)
// GET /api/stock?scope=org&guildId=G[&holder=U]       the org's stock (active members only)
// GET /api/stock?scope=all                            both: your personal stock and every org's you are
//                                                     an active member of
// Writes: POST /api/stock/add | remove | adjust | move with the request types below.

export interface StockBatch {
  id: number;
  // The orgs it is shared in (guild IDs; someone else's batch: only orgs you are in too)
  sharedIn: string[];
  // A part split off from its main batch (POST /api/stock/merge puts it back)
  part: boolean;
  kind: 'resource' | 'item';
  // A ship component (shown in its own view, not in the stock view)
  component: boolean;
  // Components: the stats, {property UUID: value in CatalogStat's unit} (CatalogMaterial.stats names them); null = none
  stats: Record<string, string> | null;
  subjectUuid: string;
  material: string;
  locationUuid: string;
  location: string;
  state: 'stored' | 'refining';
  quality: number;
  // Exact decimal text without trailing zeros ("12.5"); send it back as `expected`
  quantity: string;
  unit: 'SCU' | 'pcs';
  // Whose it is (shared or not)
  holderUserId: string;
  // Shared stock: the owner's name in an org it is shared in
  holderName: string | null;
  // Whether you may change it: yours only
  canChange: boolean;
  // Refinery jobs only (the quantity is the expected yield); the fields are NULL on jobs started without them
  refine: StockRefine | null;
}

export interface StockRefine {
  // The work order: the batches of one job share it (start and end are the job's)
  jobId: string;
  // ISO timestamps
  startedAt: string | null;
  endsAt: string | null;
}

export interface StockListResponse {
  batches: StockBatch[];
  // Sum per material (subjectUuid -> exact decimal text) over the listed stored batches (refinery jobs left out)
  totals: Record<string, string>;
}

// Writes: POST, JSON. Only the owner changes a batch. Sharing: POST /api/stock/share sets the orgs a
// batch is shared in (the whole batch; a part is split off first: /api/stock/split, unshared batches
// only). `guildId` = the org the action happens in: to give to one of its members; you must be an
// active member there (403 notMember), as in every org you add shared stock to (`guildIds`).
// `expected` = the quantity the user saw: the server refuses with batchChanged if it changed meanwhile.
// Amounts are text as typed ("12,5" or "12.5"); null = the whole batch.

export interface StockAddRequest {
  subjectUuid: string;
  locationUuid: string;
  quality: number;
  amount: string;
  // Shared in these orgs right away (else unshared; the batch it lands in keeps its shares)
  guildIds?: string[];
  // Components only: stats in CatalogStat's unit, {property UUID: value} (the component's CatalogMaterial.stats,
  // within min/max; empty values are left out; else 422 invalidStats). Batches with other stats stay apart
  stats?: Record<string, string>;
}

// Every successful write answers { ok: true }; lists update through the realtime channel
export interface OkResponse {
  ok: true;
}

// --- blueprints (yours) ----------------------------------------------------------------------------
// GET /api/blueprints                 your registered blueprints
// POST /api/blueprints/add            { uuid }   (not default, not retired)
// POST /api/blueprints/remove         { uuid }

export interface BlueprintListResponse {
  uuids: string[];
}

// --- companion app release --------------------------------------------------------------------------
// The companion sends its version in X-QM-Companion; older than the server's release (or missing, while the
// server has one) = 426 CompanionOutdated for every token request.
export type CompanionPlatform = 'windows' | 'linux';

export interface CompanionOutdated {
  error: 'companionOutdated';
  version: string;
  // Absolute URLs per platform
  downloads: Partial<Record<CompanionPlatform, string>>;
}
