// Response types of the user web app API, shared with its SPA. Pure types: no server imports.
import type { ResourceDetail } from '../adminapp/api-types.ts';

export interface MeOrg {
  guildId: string;
  name: string;
  // The user's name on that server (roster)
  displayName: string;
  officer: boolean;
  // False while the bot cannot vouch for this org's roster: its org stock is read-only then
  rosterFresh: boolean;
  // How long it stays fresh without a new beat (0 when stale): the SPA asks again then, since the
  // bot's minute beat itself is not announced (only fresh <-> stale changes made in the DB are)
  rosterFreshForMs: number;
  // False once the bot was removed from the server (the roster is frozen, so never fresh)
  botPresent: boolean;
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
// further codes: notLoggedIn (401), notMember (403: not an active member of that org), rosterStale
// (409: org stock is read-only while the bot cannot vouch for the roster), invalid (400: malformed
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
  // Ores go through the refinery only (never "add")
  isOre: boolean;
  // SCU for resources, pieces for items
  unit: 'SCU' | 'pcs';
  // Items: the item type (for its icon) and its display name; null for resources
  type: string | null;
  typeLabel: string | null;
}

export interface CatalogLocation {
  uuid: string;
  // "Area18 · ArcCorp · Stanton"
  label: string;
  // "Area18", plus the system where the name alone is ambiguous
  short: string;
  // Has a refinery (per UEX; every location while there is no UEX data yet)
  refinery: boolean;
  // Refinery yield bonus in % per ore UUID (per UEX; only ores UEX reports for this refinery)
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
}

/** A refining method with its community values (estimates, see ext.refining_method). */
export interface CatalogRefiningMethod {
  code: string;
  name: string;
  yieldPct: number;
  secondsPerScu: number;
}

export interface CatalogResponse {
  materials: CatalogMaterial[];
  locations: CatalogLocation[];
  blueprints: CatalogBlueprint[];
  // Best yield first
  methods: CatalogRefiningMethod[];
}

// --- stock -------------------------------------------------------------------------------------
// All take &lang=de|en for material and location names and answer StockListResponse.
// GET /api/stock?scope=personal                       your personal stock (incl. refinery jobs)
// GET /api/stock?scope=org&guildId=G[&holder=U]       the org's stock (active members only)
// GET /api/stock?scope=all                            both: your personal stock and every org's you are
//                                                     an active member of
// Writes: POST /api/stock/add | remove | adjust | move with the request types below.

export interface StockBatch {
  id: number;
  designation: 'personal' | 'org';
  guildId: string | null;
  kind: 'resource' | 'item';
  subjectUuid: string;
  material: string;
  locationUuid: string;
  location: string;
  state: 'stored' | 'refining';
  quality: number;
  // Exact decimal text without trailing zeros ("12.5"); send it back as `expected`
  quantity: string;
  unit: 'SCU' | 'pcs';
  // Who holds it (personal: the owner)
  holderUserId: string;
  // Org stock: the holder's name in that org
  holderName: string | null;
  // Whether you may remove/adjust/move it (personal: yours; org: officers of that org)
  canChange: boolean;
  // Refinery jobs only; the fields are NULL on jobs started without them
  refine: StockRefine | null;
}

export interface StockRefine {
  // The work order: the ore batches of one job share it (start and end are the job's)
  jobId: string;
  // ISO timestamps
  startedAt: string | null;
  endsAt: string | null;
  // Expected refined SCU of this ore batch (an estimate), exact decimal text
  expectedYield: string | null;
}

export interface StockListResponse {
  batches: StockBatch[];
  // Sum per material (subjectUuid -> exact decimal text) over the listed batches
  totals: Record<string, string>;
}

// Writes: POST, JSON. `guildId` = the org the action happens in; required for anything touching org
// stock (add as org stock, donate, change an org batch), omitted for personal stock. `expected` = the
// quantity the user saw: the server refuses with batchChanged if the batch changed meanwhile.
// Amounts are text as typed ("12,5" or "12.5"); null = the whole batch.

export interface StockAddRequest {
  subjectUuid: string;
  locationUuid: string;
  quality: number;
  amount: string;
  // Book as org stock of this org (else personal)
  guildId?: string;
  // Org stock: holder (default you; others for officers only)
  holderUserId?: string;
}

export interface StockRemoveRequest {
  batchId: number;
  amount: string | null;
  expected: string;
  guildId?: string;
}

export interface StockAdjustRequest {
  batchId: number;
  // Counted amount ("0" empties the batch)
  amount: string;
  expected: string;
  guildId?: string;
}

export interface StockMoveRequest {
  batchId: number;
  amount: string | null;
  expected: string;
  guildId?: string;
  toLocationUuid?: string;
  // true: becomes org stock of guildId (donation); false: becomes personal stock
  toOrg?: boolean;
  // New holder (org) or the member who gets org stock as personal stock
  toHolderUserId?: string;
}

// Refinery jobs are always personal and always work orders: one station and time, several ores
// (POST /api/refinery/start, /api/refinery/done)
export interface RefineryStartRequest {
  locationUuid: string;
  // Estimate for the whole job (the SPA prefills it from a refining method the user may pick): processing time
  durationSeconds?: number;
  // 1 to 30 ores
  rows: RefineryStartRow[];
}

export interface RefineryStartRow {
  oreUuid: string;
  quality: number;
  amount: string;
  // Estimate, prefilled and editable: refined SCU of this ore ("0" allowed)
  expectedYield?: string;
}

// Finishes the whole job: one row per ore batch of the job (StockRefine.jobId), no more, no less
export interface RefineryDoneRequest {
  jobId: string;
  rows: RefineryDoneRow[];
}

export interface RefineryDoneRow {
  batchId: number;
  // The refined quantity as the game shows it ("0": nothing came out); the quality is the ore's
  amount: string;
  // The ore quantity shown
  expected: string;
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
  officer: boolean;
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
  // Stored stock per kind: distinct materials, the amount (resources in SCU, items in pieces; exact
  // decimal text) and the distinct locations
  resources: { kinds: number; scu: string; locations: number };
  items: { kinds: number; pieces: string; locations: number };
}

export interface RefiningMetrics {
  jobs: number;
  // Sum of the ore rows' expected yields in SCU; null when no row has one
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

// --- companion app release (GET /api/companion; files at GET /downloads/companion/<file>, session or API token)
export type CompanionPlatform = 'windows' | 'linux';

export interface CompanionDownload {
  platform: CompanionPlatform;
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
// Your own actions and what others did to your data (an officer booking your org stock), newest
// first, 100 per page; `before` = the last id you have, `after` = only newer than this id. Optional
// filters: source, category, action (add, remove, adjust, move, start, done), by (me | others).

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
  // Refinery start (estimates as entered)
  durationSeconds: number | null;
  expectedYield: string | null;
  // Refinery done: the ore that went in
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
  // A new history entry concerning you (yours, or someone acted on your data): GET /api/history?after
  | { type: 'history'; id: number; source: HistorySource }
  // Changes may have been missed (the server lost its DB listener): reload everything
  | { type: 'resync' }
  | { type: 'pong' };

export type ClientMessage = { type: 'ping' };
