// Response types of the user web app API, shared with its SPA. Pure types: no server imports.
import type { ResourceDetail } from '../adminapp/api-types.ts';

export interface MeOrg {
  guildId: string;
  name: string;
  // The user's name on that server (roster)
  displayName: string;
}

export interface MeResponse {
  userId: string;
  // Discord display name (global name, else username) and username, as of the last login; avatar: the Discord avatar
  // URL. All three are null for a user without a Discord profile (the singleuser variant's local user)
  name: string | null;
  username: string | null;
  avatarUrl: string | null;
  // Active memberships only
  orgs: MeOrg[];
  // Star Citizen account name, shown to the user's orgs; null = not set
  rsiHandle: string | null;
  // The web app's language override (the bot keeps its own); null = follow the browser
  langOverride: Lang | null;
  // Privilege keys in force (`<feature>.<right>`, docs/webapp.md "Features and privileges"): what this user may
  // do in the features beyond the roles
  privileges: string[];
}

export type Lang = 'de' | 'en';

// --- capabilities (GET /api/capabilities, the one API route without a login) -----------------------
// What this server offers; the SPA and the companion ask before anything else.
/** What a server offers, as its composition root states it (`WebappConfig.capabilities`). */
export interface ServerCapabilities {
  // How a user gets in: 'discord' = the Discord login (/auth/login, sessions, API tokens for the companion);
  // 'none' = no login at all, every request is the one local user's (no /auth/*, no /api/token)
  login: 'discord' | 'none';
  // Orgs exist: the org routes (/api/orgs/…) and org scopes
  orgs: boolean;
  // UEX trading data (prices, terminals) is offered
  uex: boolean;
}

/**
 * The companion app's API contract number: what a companion built from this tree sends in `X-QM-Companion-Api`, and
 * for a server its maximum (the number it was built with). Raised when the contract changes in a way an older
 * companion cannot follow (or, the other way round, a newer companion needs something an older server lacks).
 */
export const COMPANION_API = 1;
/** The oldest contract number a server still accepts from a companion; never above COMPANION_API. */
export const COMPANION_API_MIN = 1;

/** The answer of GET /api/capabilities: the server's capabilities and the installed game data. */
export interface Capabilities extends ServerCapabilities {
  // The latest catalog import's game version (label `4.10.2.12913470`, and its build number); null = no catalog installed
  game: { label: string | null; build: number } | null;
  // The companion contract numbers this server accepts: `min` (COMPANION_API_MIN) to `max` (COMPANION_API)
  companionApi: { min: number; max: number };
}

// --- errors -----------------------------------------------------------------------------------
// Every non-2xx answer: { error: code }. Stock codes as in src/stock/service.ts (StockErrorCode);
// further codes: notLoggedIn (401), notMember (403: not an active member of that org), invalid (400: malformed
// request), notFound (404), unknownBlueprint, blueprintDefault, blueprintRetired, invalidHandle (422).
export interface ApiErrorBody {
  error: string;
}

// --- catalog (GET /api/catalog?lang=de|en) -------------------------------------------------------
// Everything the pickers need, in the requested language; filter and search in the browser.

export interface CatalogMaterial {
  uuid: string;
  kind: 'resource' | 'item';
  name: string;
  // The game's localization key of the name (lower case): API consumers look it up in the player's language pack
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
  // Its thumbnail's hash (src/thumbs.ts: thumbPath(size, uuid, thumb)); null = none, show the type icon
  thumb: string | null;
}

export interface CatalogStat {
  // The crafted property (the key in StockBatch.stats and StockAddRequest.stats)
  uuid: string;
  // As the game names it ("Coolant Rating")
  name: string;
  // The game's localization key of that name (lower case): API consumers look it up in the player's language pack
  nameKey: string | null;
  // What the blueprint can make of it, like the crafting check shows it: a multiplier as its change in
  // percent (min/max e.g. -19.3/20.8, one decimal), additive steps as whole numbers (power pips, e.g. -2/2)
  kind: 'multiplier' | 'additive';
  min: number;
  max: number;
  // The unmodified value as the game's tooltip shows it ("Coolant Rating: 60.00" -> 60); null when the
  // app does not know where the record keeps it (consumers then read no stats off such a tooltip)
  base: number | null;
  // How the tooltip shows it: its value (converted with `base`) or its change in percent, negated for
  // some ("Recoil Smoothness: +28.44 %" for a stored -28.4; src/stock/component-base.ts)
  tooltip: 'value' | 'change' | 'negatedChange';
}

export interface CatalogLocation {
  uuid: string;
  // The star map record's key ("RR_CRU_LEO"), as Game.log names the player's location
  key: string;
  // "Area18 · ArcCorp · Stanton"
  label: string;
  // "Area18", plus the system where the name alone is ambiguous
  short: string;
  // The game's localization key of the name (lower case), as for materials
  nameKey: string | null;
  // Has a refinery (the catalog's flag; every location while none is flagged yet)
  refinery: boolean;
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
  // The item it crafts and that item's thumbnail hash (thumbPath(size, outputUuid, thumb)); null = none
  outputUuid: string | null;
  thumb: string | null;
}

export interface CatalogResponse {
  materials: CatalogMaterial[];
  locations: CatalogLocation[];
  blueprints: CatalogBlueprint[];
}

// --- the companion app's catalog (GET /api/companion/catalog?lang=de|en) ---------------------------
// The rows of GET /api/catalog with only the fields the companion reads (the unit follows from `kind`);
// cached the same way (ETag, revalidated).

export type CompanionCatalogMaterial = Pick<CatalogMaterial,
  'uuid' | 'kind' | 'name' | 'nameKey' | 'type' | 'typeLabel' | 'component' | 'label' | 'size' | 'gradeLetter' | 'stats' | 'thumb'>;
export type CompanionCatalogLocation = Pick<CatalogLocation, 'uuid' | 'key' | 'label' | 'short' | 'nameKey' | 'refinery'>;
export type CompanionCatalogBlueprint = Pick<CatalogBlueprint,
  'uuid' | 'label' | 'name' | 'size' | 'gradeLetter' | 'isDefault' | 'retired' | 'outputUuid' | 'thumb'>;

// A rock kind with its radar signature for one node (a ship's scan shows it times the cluster's nodes): the resource
// it is named after (an ore, not bookable: by name), the mining method, the rarity (ship rocks)
export interface CompanionCatalogRock {
  resourceUuid: string;
  name: string;
  method: 'ship' | 'roc' | 'fps';
  rarity: string | null;
  radarSignature: number;
}

export interface CompanionCatalogResponse {
  materials: CompanionCatalogMaterial[];
  locations: CompanionCatalogLocation[];
  blueprints: CompanionCatalogBlueprint[];
  rocks: CompanionCatalogRock[];
}

// --- the companion app's English texts (GET /api/companion/locale) -----------------------------------
// text/plain, the lines `key=value` of a global.ini (a line break in a value as the literal `\n`): the game's own
// English texts only. ETag, gzip when accepted; 404 `{ error: 'noCatalog' }` without an installed catalog.

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

export interface StockRemoveRequest {
  batchId: number;
  amount: string | null;
  expected: string;
}

export interface StockAdjustRequest {
  batchId: number;
  // Counted amount ("0" empties the batch)
  amount: string;
  expected: string;
  // Components only: the whole new set of stats as in StockAddRequest ({} = none; omitted = unchanged).
  // Other stats move the batch to that key (merged into a batch with the same stats, if any)
  stats?: Record<string, string>;
}

export interface StockMoveRequest {
  batchId: number;
  amount: string | null;
  expected: string;
  guildId?: string;
  toLocationUuid?: string;
  // Give it to this active member of guildId: it becomes theirs, unshared (you or omitted: stays yours)
  toOwnerUserId?: string;
}

export interface StockSplitRequest {
  batchId: number;
  // The part split off into a batch of its own (less than the batch)
  amount: string;
  expected: string;
}

export interface StockMergeRequest {
  batchId: number;
  expected: string;
}

export interface StockShareRequest {
  batchId: number;
  // Every org it shall be shared in from now on ([] = unshared)
  guildIds: string[];
}

// Refinery jobs are always personal and always work orders: one station and time, several refined materials
// with their expected yields (ores are not booked) (POST /api/refinery/start, /duration, /done, /remove)
export interface RefineryStartRequest {
  locationUuid: string;
  // Estimate for the whole job (the terminal's time left); left out: the end stays open until set with
  // /api/refinery/duration
  durationSeconds?: number;
  // 1 to 30 materials
  rows: RefineryStartRow[];
}

export interface RefineryStartRow {
  // A refined, bookable resource
  resourceUuid: string;
  quality: number;
  // The expected yield in SCU
  amount: string;
}

// Sets the time a running job still needs: end = now + durationSeconds (the terminal's time left); null clears it
export interface RefineryDurationRequest {
  jobId: string;
  durationSeconds: number | null;
}

// Finishes the whole job: one row per batch of the job (StockRefine.jobId), no more, no less; each is stored
export interface RefineryDoneRequest {
  jobId: string;
  rows: RefineryDoneRow[];
}

export interface RefineryDoneRow {
  batchId: number;
  // The quantity the game hands out ("0": nothing came out); the quality stays
  amount: string;
  // The expected yield shown (the batch's quantity)
  expected: string;
}

// Removes the whole job (it will not come out): every batch of the job, no more, no less
export interface RefineryRemoveRequest {
  jobId: string;
  rows: { batchId: number; expected: string }[];
}

// Every successful write answers { ok: true }; lists update through the realtime channel
export interface OkResponse {
  ok: true;
}

// --- orgs ----------------------------------------------------------------------------------------
// GET /api/orgs/:guildId/members                       OrgMember[]: active members (holder pickers, lists)
// GET /api/orgs/:guildId/blueprints                    OrgBlueprintsResponse: every blueprint an active
//                                                      member registered, with who has it

export interface OrgMember {
  userId: string;
  displayName: string;
  rsiHandle: string | null;
}

export interface BlueprintOwner {
  userId: string;
  displayName: string;
  rsiHandle: string | null;
}

export interface OrgBlueprintsResponse {
  // Owners alphabetical
  entries: Array<{ uuid: string; owners: BlueprintOwner[] }>;
}

// --- blueprints (yours) ----------------------------------------------------------------------------
// GET /api/blueprints                 your registered blueprints
// POST /api/blueprints/add            { uuid }   (not default, not retired)
// POST /api/blueprints/remove         { uuid }

export interface BlueprintListResponse {
  uuids: string[];
}

export interface BlueprintRequest {
  uuid: string;
}

// --- summary (GET /api/summary) for the overview --------------------------------------------------

export interface StockMetrics {
  // Stored stock per kind: distinct materials, the amount (resources in SCU, items and components in
  // pieces; exact decimal text) and the distinct locations; items without the ship components
  resources: { kinds: number; scu: string; locations: number };
  items: { kinds: number; pieces: string; locations: number };
  components: { kinds: number; pieces: string; locations: number };
}

export interface RefiningMetrics {
  jobs: number;
  // Sum of the jobs' expected yields in SCU; null without any job
  expected: string | null;
  // Distinct stations of the running jobs
  locations: number;
  // End of every job that has one (ISO), for the countdown to the next one
  endsAt: string[];
}

export interface SummaryResponse {
  // Blueprints a player can unlock: not retired, not default, in a reward pool of the game data.
  // The registered counts are not capped by it (a higher count means the game data is incomplete)
  obtainableBlueprints: number;
  personal: StockMetrics & { refining: RefiningMetrics; blueprints: number; value: StockValue | null };
  // Your active memberships, in the order of /api/me
  orgs: Array<StockMetrics & { guildId: string; members: number; blueprints: number; value: StockValue | null }>;
}

// The stored stock at the best UEX sell price, in aUEC (whole numbers as text); batches without a price
// do not count; null without any UEX prices. resources = the Ressourcen view (materials and
// harvestables), components = Ausrüstung
export interface StockValue {
  total: string;
  resources: string;
  components: string;
}

// --- crafting check (the admin UI's planner; all take &lang=de|en) ---------------------------------
// GET /api/crafting/blueprints                       BlueprintRow[]  (types from src/adminapp/api-types.ts)
// GET /api/crafting/resources                        ResourceRow[]
// GET /api/crafting/items                            ItemRow[]
// GET /api/crafting/used-by?kind=resource|item&uuid=  CraftingUse[]: recipes that take it
// GET /api/crafting/recipes?uuids=a,b                PlannerData (src/planner/types.ts), max 200

export type CraftingUse = ResourceDetail['usedBy'][number];

// --- info cards (hover tooltips with game data; &lang=de|en) -------------------------------------
// GET /api/info/blueprint/:uuid   BlueprintInfo
// GET /api/info/material/:uuid    MaterialInfo (a resource or an item)

export interface BlueprintInfo {
  name: string;
  type: string | null;
  typeLabel: string | null;
  subTypeLabel: string | null;
  size: number | null;
  gradeLetter: string | null;
  itemClass: string | null;
  manufacturer: string | null;
  category: string | null;
  isDefault: boolean;
  retired: boolean;
  // First tier: requiredSlots of the slots are filled, each with one of its inputs
  requiredSlots: number;
  slots: Array<{ name: string | null; inputs: Array<{ name: string; kind: 'resource' | 'item'; quantity: string; minQuality: number }> }>;
  // One line per kind of source (missions, event tiers); empty = no unlock in the game data
  unlocks: UnlockSummary[];
}

// --- blueprint unlocks (catalog.blueprint_source; &lang=de|en) ---------------------------------------
// GET /api/unlocks/:uuid   UnlocksResponse (404 for an unknown blueprint)

export type UnlockKind = 'mission' | 'event';
// illegal, event (started by hand: ORS), chain (needs an earlier contract), rank (a minimum reputation),
// random (the pool comes only sometimes), onAccept (handed out on accepting the contract)
export type UnlockMarker = 'illegal' | 'event' | 'chain' | 'rank' | 'random' | 'onAccept';

/** The pool hands out one entry by weight: num of den (reduced); chance < 1: the pool itself only sometimes (null = always). */
export interface UnlockOdds {
  num: number;
  den: number;
  chance: number | null;
}

export interface UnlockSummary {
  kind: UnlockKind;
  // Sources of this kind (contracts or event tiers, per pool)
  count: number;
  // Only the markers that hold for every one of them
  markers: UnlockMarker[];
  // The best odds; varies: the sources' odds differ ("up to")
  best: UnlockOdds;
  varies: boolean;
}

export interface UnlockMissionRow {
  // The game's placeholders ("~mission(Location)") as "…"; no text: the contract's debug name
  title: string;
  rank: string | null;
  // Systems the contract is offered in (sorted), places it is bound to (not a system itself)
  systems: string[];
  locations: string[];
  // chain, illegal, onAccept
  markers: UnlockMarker[];
  // The event a manually started scenario belongs to ("ORS")
  event: string | null;
  odds: UnlockOdds;
  // Equal rows merged
  count: number;
}

/** Missions of one faction and mission type. */
export interface UnlockMissionGroup {
  faction: string | null;
  missionType: string | null;
  count: number;
  systems: string[];
  // Lowest and highest rank (equal when one); null without any rank
  rankFrom: string | null;
  rankTo: string | null;
  best: UnlockOdds;
  varies: boolean;
  rows: UnlockMissionRow[];
}

export interface UnlockEventTier {
  event: string;
  minPoints: number | null;
  odds: UnlockOdds;
  count: number;
}

export type UnlockSection = { kind: 'mission'; count: number; groups: UnlockMissionGroup[] } | { kind: 'event'; count: number; tiers: UnlockEventTier[] };

export interface UnlocksResponse {
  name: string;
  sections: UnlockSection[];
}

export interface MaterialInfo {
  kind: 'resource' | 'item';
  // Items: the blueprints (not retired) that craft it, with their unlocks as in BlueprintInfo; resources: none
  craftedBy: Array<{ uuid: string; name: string; isDefault: boolean; unlocks: UnlockSummary[] }>;
  name: string;
  // Items: the item type (icon)
  type: string | null;
  // The game's description text
  description: string | null;
  // Resources: "Group › Subgroup", ore and refined counterparts
  group: string | null;
  isOre: boolean;
  refined: string | null;
  ores: string[];
  // Items
  typeLabel: string | null;
  subTypeLabel: string | null;
  size: number | null;
  gradeLetter: string | null;
  itemClass: string | null;
  manufacturer: string | null;
  // Blueprints that take it
  usedIn: number;
  // UEX prices; null = none
  prices: PriceSummary | null;
}

// --- mining (catalog.mining_provider, catalog.mineable; &lang=de|en) ---------------------------------
// GET /api/mining         MiningIndexResponse
// GET /api/mining/:uuid   MiningResponse: a mined resource, a refined one (from its ores) or an item (a gem)

export type MiningMethod = 'ship' | 'roc' | 'fps';

export interface MiningResource {
  // The mined resource (ore, raw material, gem)
  uuid: string;
  name: string;
  // What it refines into (ores); null for what is used as mined
  refinedUuid: string | null;
  refined: string | null;
  // The item a gem rock breaks into (recipes take it)
  itemUuid: string | null;
  methods: MiningMethod[];
}

export interface MiningIndexResponse {
  resources: MiningResource[];
}

/** The quality a part spawns with: its range and the values the material's quality bands map it to (0–1 chances; empty without bands). */
export interface MiningQuality {
  min: number;
  max: number;
  values: Array<{ value: number; chance: number }>;
}

export interface MiningRow {
  // The mined resource (several for a refined material from more than one ore)
  ore: string;
  // Its uuid and thumbnail hash (thumbPath(size, oreUuid, thumb); null = none): ores are no catalog materials
  oreUuid: string;
  thumb: string | null;
  // The place's name; null for a group of instanced places (group, count)
  place: string | null;
  // A moon's planet
  parent: string | null;
  system: string | null;
  // 'miningBase': asteroid mining bases, 'qvStation': QV extraction stations (the same layout in many places)
  group: 'miningBase' | 'qvStation' | null;
  count: number;
  method: MiningMethod;
  // Percent of the method's rocks there holding the ore (its rich part's share)
  share: number;
  // common, uncommon, rare, epic, legendary (ship rocks)
  rarity: string | null;
  // The rock's parts of the ore: the rich one (factor 1) first, then the lean ones
  parts: MiningPart[];
}

/** One part of an ore in a rock. */
export interface MiningPart {
  // Quality factor: 1 = the rich part, below 1 a lean part (quality × factor)
  qualityScale: number;
  // Percent of the method's rocks there holding the part
  share: number;
  // Percent of such a rock
  minPercent: number;
  maxPercent: number;
  quality: MiningQuality | null;
}

export interface MiningResponse {
  name: string;
  rows: MiningRow[];
}

// --- trading (UEX community prices in aUEC per SCU or piece) --------------------------------------
// GET /api/trade/prices    TradePricesResponse: the summary of every bookable material with a price
// GET /api/trade/items?lang=       TradeItemsResponse: every material with an offer, best buy/sell price
// GET /api/trade/:uuid     TradeResponse: every terminal (404 without any price)

export interface PriceRange {
  // Lowest and highest price over the terminals (0 = not traded there: left out)
  min: number;
  max: number;
  // UEX's average (commodities only; null for items or when UEX has none)
  avg: number | null;
  terminals: number;
}

export interface PriceSummary {
  // The latest report (ISO)
  date: string;
  // sell = the terminals pay (the player sells), buy = they ask (the player buys); null = none
  sell: PriceRange | null;
  buy: PriceRange | null;
}

export interface TradePricesResponse {
  prices: Record<string, PriceSummary>;
}

export interface TradeOffer {
  // The station, city or outpost, then the shop/terminal there
  location: string;
  terminal: string;
  system: string | null;
  price: number;
  // Sell: what the terminal takes (demand) and its average; buy: its stock and average; null for items
  scu: number | null;
  scuAvg: number | null;
  // The report (ISO)
  date: string;
}

export interface TradeResponse {
  prices: PriceSummary;
  // Best price first: sell highest, buy lowest
  sell: TradeOffer[];
  buy: TradeOffer[];
}

// The item finder: every catalog material with at least one offer
export interface TradeItem {
  uuid: string;
  kind: 'resource' | 'item';
  name: string;
  // Items: the item type and its display name (FPS gear with its sub type: "Helmets · Light"); resources: null
  type: string | null;
  typeLabel: string | null;
  size: number | null;
  gradeLetter: string | null;
  // Can be booked in the stock (as the catalog's materials); else a shop item only
  bookable: boolean;
  // Lowest price a terminal asks (the player buys) and highest it pays (the player sells); null = none
  buy: number | null;
  sell: number | null;
}

export interface TradeItemsResponse {
  items: TradeItem[];
}

// --- profile (POST /api/profile) ------------------------------------------------------------------
// Fields left out stay as they are; null clears. RSI handle: 3-60 letters, digits, - or _.
export interface ProfileRequest {
  rsiHandle?: string | null;
  langOverride?: Lang | null;
}

// --- API token (companion app) -------------------------------------------------------------------
// GET  /api/token -> ApiTokenInfo       (session only, 403 'sessionOnly' with a token)
// POST /api/token -> ApiTokenCreated    creates the token, replacing an existing one; shown only here
// With "Authorization: Bearer <token>" every other /api route works as the user. The companion app
// also sends its contract number in X-QM-Companion-Api (and its app version in X-QM-Companion, for logs):
// a number below COMPANION_API_MIN or none = 426 CompanionOutdated, above COMPANION_API = 409 ServerOutdated,
// for every token request (before the token is checked).

export interface ApiTokenInfo {
  // null = no token
  createdAt: string | null;
  lastUsedAt: string | null;
}

export interface ApiTokenCreated {
  token: string;
}

// --- the companion's downloads (GET /api/companion/downloads; companion-downloads.ts) ----------------
// Its stable release (channels.json on GitHub) as direct links, the main file first per platform. version null: no stable
// release known (none yet, or GitHub not reachable): no links, the releases page only.

export interface CompanionDownload {
  // The file's kind as the README's downloads block names it: Installer, Standalone, AppImage, deb, rpm
  label: string;
  url: string;
}

export interface CompanionDownloadsResponse {
  releasesUrl: string;
  version: string | null;
  windows: CompanionDownload[];
  linux: CompanionDownload[];
}

// --- companion API contract check (every companion request, any /api route but capabilities) ---------
/** 426: the companion's contract number is missing or below the server's minimum. */
export interface CompanionOutdated {
  error: 'companionOutdated';
  // COMPANION_API_MIN
  apiMin: number;
}

/** 409: the companion's contract number is above the server's maximum. */
export interface ServerOutdated {
  error: 'serverOutdated';
  // COMPANION_API
  apiMax: number;
}

// --- history (GET /api/history?lang&before&after&source&category&action&by) ------------------------
// Your own actions, what others did to your data (stock given to you) and what was shared in your
// orgs, newest first, 100 per
// page; `before` = the last id you have, `after` = only newer than this id. Optional filters: source,
// category, action (add, remove, adjust, move, share, unshare, give, start, done), by (me | others).

export type HistorySource = 'bot' | 'webapp' | 'companion';
export type HistoryCategory = 'stock' | 'refinery' | 'blueprint';

// A person in an entry; compare userId with your own to say "you"
export interface HistoryPerson {
  userId: string;
  // Their name in the org ("?" when unknown)
  name: string;
}

export interface HistoryEntry {
  id: number;
  // ISO
  at: string;
  source: HistorySource;
  category: HistoryCategory;
  // stock: add, remove, adjust, move; refinery: start, done, remove, adjust; blueprint: add, remove
  action: string;
  // Who did it
  actor: HistoryPerson;
  // The org involved (org stock), else null
  org: string | null;
  // Material or blueprint
  target: string;
  // Its uuid (the thumbnail: the catalog's materials or blueprints by uuid, CatalogMaterial.thumb / CatalogBlueprint.thumb)
  targetUuid: string;
  unit: 'SCU' | 'pcs' | null;
  // Exact decimal text without trailing zeros; null where the action has none
  amount: string | null;
  quality: number | null;
  location: string | null;
  designation: 'personal' | 'org' | null;
  // Org stock: its holder
  holder: HistoryPerson | null;
  // Move: where it went (the holder only when it changed)
  toLocation: string | null;
  toDesignation: 'personal' | 'org' | null;
  toHolder: HistoryPerson | null;
  // Adjust: the quantity before
  from: string | null;
  // Refinery start: the duration entered; done: the yield expected (older rows: start's estimate)
  durationSeconds: number | null;
  expectedYield: string | null;
  // Refinery done before ores were dropped (migration 0025): the ore that went in
  ore: string | null;
  oreAmount: string | null;
  oreQuality: number | null;
}

export interface HistoryResponse {
  entries: HistoryEntry[];
  // Older entries exist
  more: boolean;
}

// --- features (GET/PUT/DELETE /api/features/:key/entries[/:subject[/blob]], GET /api/features/:key/blob/:id; key = the feature) ---
// Whoever holds the feature's reading privilege sees every row; only the own row (`own`) can be changed, with its
// writing privilege. 403 noPrivilege without.
export interface FeatureEntry {
  id: number;
  userId: string;
  // Newest web session's Discord name, else the companion token's, else the org nickname
  userName: string | null;
  subject: string;
  payload: Record<string, unknown>;
  // The row's image (GET /api/features/:key/blob/:id?v=<updatedAt>); null = none
  blobType: string | null;
  own: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface FeatureEntriesResponse {
  entries: FeatureEntry[];
}

// PUT …/entries/:subject: { payload } (the feature's schema); PUT …/entries/:subject/blob: { type, data } (base64)
export interface FeaturePutRequest {
  payload: Record<string, unknown>;
}

export interface FeatureBlobRequest {
  type: 'image/webp' | 'image/png';
  data: string;
}

// thumb-review (GET /api/features/thumb-review/subjects?lang): every thumbnail; payload { hash } = the one it was
// marked on (a re-render brings a new hash)
export interface ThumbReviewSubject {
  uuid: string;
  name: string;
  className: string;
  // Items only (null = a resource's chunk); typeLabel = the item class's display name
  type: string | null;
  subType: string | null;
  typeLabel: string | null;
  hash: string;
}

export interface ThumbReviewSubjectsResponse {
  subjects: ThumbReviewSubject[];
}

// --- realtime (WebSocket /api/ws) ------------------------------------------------------------
// The server only says what changed; the SPA fetches it through the normal endpoints.

export type ServerMessage =
  // Your orgs, roles or an org's state (name, roster freshness, bot presence) changed: reload /api/me
  | { type: 'me' }
  // An org's member list changed
  | { type: 'members'; guildId: string }
  // Stock changed: your personal stock, or an org's
  | { type: 'stock'; scope: 'personal' }
  | { type: 'stock'; scope: 'org'; guildId: string }
  // Blueprints or profile (RSI handle) of you or someone in your orgs changed
  | { type: 'blueprints'; userId: string }
  | { type: 'profile'; userId: string }
  // A new history entry concerning you (yours, someone acted on your data, or stock shared in one of
  // your orgs): GET /api/history?after
  | { type: 'history'; id: number; source: HistorySource; actor: string }
  // A feature's data changed (to whoever holds its reading privilege; key = the feature): GET /api/features/:key/entries
  | { type: 'feature'; key: string }
  // Changes may have been missed (the server lost its DB listener): reload everything
  | { type: 'resync' }
  | { type: 'pong' };

export type ClientMessage = { type: 'ping' };

// --- singleuser: the game data update (GET /api/local/data, docs/singleuser.md "Updating the data") ---

/** Why an update failed, in a few classes; the details are in the log. */
export type DataUpdateFailure = 'corrupt' | 'invalid' | 'unsupported' | 'fileMissing' | 'internal';

export type DataUpdateOutcome =
  | { outcome: 'upToDate' | 'noChannel' | 'offline' }
  | { outcome: 'installed'; tag: string }
  // The pack's catalog format is not the app's: nothing was installed, the app must be updated (`pack`: the pack is newer or older)
  | { outcome: 'appTooOld'; tag: string; pack: 'newer' | 'older' }
  | { outcome: 'failed'; reason: DataUpdateFailure };

/** The state of the data update, kept in memory: reading it never touches the database. */
export interface DataUpdateState {
  phase: 'idle' | 'checking' | 'downloading' | 'installing';
  /** The installed data pack; null = none. */
  installed: { tag: string; gameLabel: string } | null;
  /** Bytes of the files being downloaded; null when nothing is downloading. */
  progress: { done: number; total: number } | null;
  /** The last finished operation; null = none since the start. `at` is an ISO time. */
  last: ({ at: string } & DataUpdateOutcome) | null;
}

/** POST /api/local/data/import: a full data pack file on this machine. */
export interface DataImportRequest {
  path: string;
}

// --- singleuser: the settings and the game folder (GET/PUT /api/local/settings, docs/singleuser.md "Settings") ---

/** What is wrong with a game folder: not a folder, or one of the two required files is missing. */
export type GameFolderProblem = 'notFolder' | 'noDataP4k' | 'noBuildManifest';

/** Why there is no language pack. `noUserCfg`, `noLanguage` and `builtInEnglish` are the normal English case. */
export type LanguagePackProblem = 'noUserCfg' | 'noLanguage' | 'builtInEnglish' | 'iniMissing' | 'iniUnreadable' | 'iniEmpty';

export interface GameFolderState {
  state: 'unset' | 'invalid' | 'ok';
  problem?: GameFolderProblem;
  /** The game version (`4.10.2.12913470`); absent when the folder is not ok or its manifest is unreadable. */
  gameVersion?: string;
}

/** The player's language pack as read at start. `none` = the game's English (nothing to report), `problem` = a pack was expected and is unusable. */
export interface LanguagePackState {
  state: 'none' | 'loaded' | 'problem';
  language?: string;
  /** A loaded pack's `global.ini`, relative to the game folder, with forward slashes (`data/Localization/<language>/global.ini`). */
  file?: string;
  /** Number of texts of a loaded pack. */
  texts?: number;
  /** A loaded pack is in effect: its texts show instead of the game's English (`loaded` and `active`: "active with N texts in language X"). */
  active?: boolean;
  problem?: LanguagePackProblem;
  /** The game folder changed since the start: the pack is read again at the next start only. */
  pending: boolean;
}

export interface LocalSettingsState {
  gameDir: string | null;
  autoUpdate: boolean;
  /** The UEX key is never sent back: only whether one is set (settings file or QM_UEX_KEY). */
  uexKeySet: boolean;
  /** Minutes between two UEX pulls: 15, 30 or 60. */
  uexIntervalMinutes: 15 | 30 | 60;
  /** Values the environment overrides (development): they cannot be changed here. `uexIntervalMinutes` is never overridden. */
  overridden: { gameDir: boolean; autoUpdate: boolean; uexKey: boolean; uexIntervalMinutes: boolean };
  /** The app's own version (package.json). */
  appVersion: string;
  gameFolder: GameFolderState;
  languagePack: LanguagePackState;
}

/** PUT /api/local/settings: only the values to change. */
export interface LocalSettingsUpdate {
  gameDir?: string | null;
  autoUpdate?: boolean;
  /** The user's own UEX key; null or an empty string removes it. */
  uexKey?: string | null;
  uexIntervalMinutes?: 15 | 30 | 60;
}

// --- singleuser: the UEX pull (GET /api/local/uex, docs/singleuser.md "UEX") ---

export type UexOutcome = 'ok' | 'refused' | 'offline' | 'failed';

/**
 * The state of the UEX pull, kept in memory. `off` = no key (nothing is ever requested), `idle` = waiting for `nextPull`,
 * `pulling`. The times are ISO strings; `lastPull` is when the last pull started, `last.at` when it ended. `refused` =
 * UEX does not accept the key, `offline` = no answer, `failed` = anything else (details in the log); `changed` = the
 * number of endpoints whose data changed.
 */
export interface UexState {
  phase: 'off' | 'idle' | 'pulling';
  lastPull: string | null;
  nextPull: string | null;
  last: { outcome: UexOutcome; at: string; changed?: number } | null;
}
