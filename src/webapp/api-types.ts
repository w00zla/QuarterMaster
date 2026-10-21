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
}

export type Lang = 'de' | 'en';

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
  // The record name (BP_CRAFT_…), e.g. for the SCMDB link
  key: string;
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
}

export interface CatalogResponse {
  materials: CatalogMaterial[];
  locations: CatalogLocation[];
  blueprints: CatalogBlueprint[];
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
  personal: StockMetrics & { refining: RefiningMetrics; blueprints: number };
  // Your active memberships, in the order of /api/me
  orgs: Array<StockMetrics & { guildId: string; members: number; blueprints: number }>;
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
  craftSeconds: number | null;
  // First tier: requiredSlots of the slots are filled, each with one of its inputs
  requiredSlots: number;
  slots: Array<{ name: string | null; inputs: Array<{ name: string; kind: 'resource' | 'item'; quantity: string; minQuality: number }> }>;
}

export interface MaterialInfo {
  kind: 'resource' | 'item';
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
// also sends its version in X-QM-Companion; older than the server's release (or missing, while the
// server has one) = 426 CompanionOutdated for every token request.

export interface ApiTokenInfo {
  // null = no token
  createdAt: string | null;
  lastUsedAt: string | null;
}

export interface ApiTokenCreated {
  token: string;
}

// --- companion app release (GET /api/companion; files at GET /downloads/companion/<file>, session or API token;
// the installed app's update feed at GET /downloads/companion/latest.json, Tauri updater format)
export type CompanionPlatform = 'windows' | 'linux';

export interface CompanionDownload {
  platform: CompanionPlatform;
  // setup = the installed app (Windows, updates itself); standalone = the bare exe zipped, the AppImage
  kind: 'setup' | 'standalone';
  file: string;
  // Bytes
  size: number;
  // Path on this server
  url: string;
}

export interface CompanionInfo {
  // null = the server has no release
  version: string | null;
  downloads: CompanionDownload[];
}

export interface CompanionOutdated {
  error: 'companionOutdated';
  version: string;
  // Absolute URLs per platform
  downloads: Partial<Record<CompanionPlatform, string>>;
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
  // Changes may have been missed (the server lost its DB listener): reload everything
  | { type: 'resync' }
  | { type: 'pong' };

export type ClientMessage = { type: 'ping' };
