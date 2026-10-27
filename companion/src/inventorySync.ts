// The inventory scan in the app: the OCR's reads (Rust event "inventory-read") go through
// InventoryScan (inventory.ts: the freight manager's warehouse, materials and items) and
// ComponentScan (components.ts: the character inventory, ship components and FPS gear) into sightings; each
// complete sighting is a proposal (one per stack, with what the user's stored stock at its location
// already holds of that material and quality; one per gear tile, a stack of attachments with its count), which waits until the user
// registers or dismisses it. One the stored stock already holds (registered here or before: stacks by
// amount, gear by pieces per item and stats) stays listed, marked `inStock`. The kind filter (Mats / Items / Comps / FPS, kept in localStorage; all may be
// off) decides what is detected at all, and which screens the scan reads (scan.ts). Every location
// collects its own sightings: the location picked (kept, changeable while scanning: the player walks
// from one warehouse to the next) is where a read belongs, and a proposal is registered at its own
// location. With the auto toggle on (kept, on by default) the location follows Game.log's last one
// (Rust `log_state`): a key that is no selectable location clears the pick, so nothing is booked at
// the place before; a pick by hand holds until the log names another place. Starting the scan clears
// the sightings of the run before. The catalog (names in both languages plus the player's language
// pack) is the refinery sync's.
import { emit, listen } from "@tauri-apps/api/event";
import { computed, ref, watch } from "vue";
import type { OkResponse, StockBatch, StockListResponse } from "../../src/webapp/api-types";
import {
  addRequest as componentRequest, ComponentScan, inStockOf as componentsInStock, proposalsOf as componentProposalsOf, type ComponentProposal, type ComponentSighting,
} from "./components";
import { addRequest, inStockOf, InventoryScan, proposalsOf, type InventoryReadEvent, type Proposal, type Sighting } from "./inventory";
import { ensureCatalog, syncCatalog } from "./refinerySync";
import { api, connected, log } from "./state";
import { toastError } from "./toasts";

const LOCATION_KEY = "qm.companion.inventory.location";
const AUTO_LOCATION_KEY = "qm.companion.inventory.autoLocation";
const KINDS_KEY = "qm.companion.inventory.kinds";

// comps = ship components, fps = FPS gear (2026-10-22)
export type Kind = "mats" | "items" | "comps" | "fps";
export const KINDS: Kind[] = ["mats", "items", "comps", "fps"];
// Each kind's tag colour and icon (panel rows, filter chips, the overlay's head)
export const KIND_CLASS = { mats: "ok", items: "", comps: "accent", fps: "app" } as const satisfies Record<Kind, string>;
export const KIND_ICON = { mats: "resource", items: "item", comps: "type-module", fps: "type-personal-weapon" } as const satisfies Record<Kind, string>;
// The kinds the filter knew before FPS gear (the stored list of then): a kind added later starts on
const OLD_KINDS: Kind[] = ["mats", "items", "comps"];

/** A sighting or proposal with the location it belongs to (its key and id unique across locations). */
export type Located<T> = T & { locationUuid: string };
/** A proposal as listed: whether the stored stock already holds it (registered here or before: dimmed, not to register). */
export type Listed<T> = Located<T> & { inStock: boolean };

// Each location's own scans (their pending reads and last tile stay apart too)
const scans = new Map<string, { stacks: InventoryScan; components: ComponentScan }>();
function scansAt(location: string) {
  let at = scans.get(location);
  if (!at) {
    at = { stacks: new InventoryScan(), components: new ComponentScan() };
    scans.set(location, at);
  }
  return at;
}
const located = <T extends { key: string; atMs: number }>(location: string, list: T[]): Located<T>[] =>
  list.map((s) => ({ ...s, key: `${location}|${s.key}`, locationUuid: location }));

export const sightings = ref<Located<Sighting>[]>([]);
export const componentSightings = ref<Located<ComponentSighting>[]>([]);
export const locationUuid = ref<string | null>(localStorage.getItem(LOCATION_KEY));
const batches = ref<StockBatch[]>([]);
// Sightings the user discarded or registered: no proposal any more, still listed in the debug window
const dismissed = ref(new Set<string>());
const registered = ref(new Set<string>());

// Stored as the kinds on and the kinds known then ({on, known}; before FPS gear a plain list of the kinds on)
function storedKinds(): Set<Kind> {
  try {
    const stored = JSON.parse(localStorage.getItem(KINDS_KEY) ?? "null") as unknown;
    const { on, known } = Array.isArray(stored) ? { on: stored, known: OLD_KINDS } : (stored as { on?: unknown; known?: unknown } | null) ?? {};
    if (Array.isArray(on) && Array.isArray(known)) return new Set(KINDS.filter((k) => on.includes(k) || !known.includes(k)));
  } catch {
    // Not valid: every kind
  }
  return new Set(KINDS);
}

// What the scan detects (none at all: the warehouse and the inventory are not read); a change applies to the reads from then on
export const kinds = ref<Set<Kind>>(storedKinds());

export function toggleKind(kind: Kind) {
  const next = new Set(kinds.value);
  if (next.has(kind)) next.delete(kind);
  else next.add(kind);
  kinds.value = next;
  localStorage.setItem(KINDS_KEY, JSON.stringify({ on: [...next], known: KINDS }));
}

export function setLocation(uuid: string | null) {
  locationUuid.value = uuid;
  if (uuid) localStorage.setItem(LOCATION_KEY, uuid);
  else localStorage.removeItem(LOCATION_KEY);
}

// The location from Game.log: on or off (kept, on by default), the key it named last and its selectable location (null: none or not selectable)
export const autoLocation = ref(localStorage.getItem(AUTO_LOCATION_KEY) !== "0");
export const loggedLocation = computed(() => log.value?.location ?? null);
export const loggedLocationUuid = computed(() => {
  const key = loggedLocation.value?.toLowerCase();
  return key ? syncCatalog.value?.locations.find((l) => l.key.toLowerCase() === key)?.uuid ?? null : null;
});

export function toggleAutoLocation() {
  autoLocation.value = !autoLocation.value;
  localStorage.setItem(AUTO_LOCATION_KEY, autoLocation.value ? "1" : "0");
}

// Applied when turned on, when the log names another place and once the catalog is there (not on a reload of it)
const catalogReady = computed(() => !!syncCatalog.value);
watch([autoLocation, loggedLocation, catalogReady], () => {
  if (autoLocation.value && loggedLocation.value && syncCatalog.value) setLocation(loggedLocationUuid.value);
});

const kept = (p: { id: string }) => !dismissed.value.has(p.id);
const locationsOf = (list: { locationUuid: string }[]) => [...new Set(list.map((s) => s.locationUuid))];
// Per location: its sightings against its stored stock; the discarded ones go, the ones the stock holds stay marked
export const proposals = computed<Listed<Proposal>[]>(() =>
  locationsOf(sightings.value).flatMap((location) => {
    const list = proposalsOf(sightings.value.filter((s) => s.locationUuid === location), batches.value, location).filter(kept);
    const held = inStockOf(list, batches.value, location, registered.value);
    return list.map((p) => ({ ...p, locationUuid: location, inStock: held.has(p.id) }));
  }),
);
export const componentProposals = computed<Listed<ComponentProposal>[]>(() =>
  locationsOf(componentSightings.value).flatMap((location) => {
    const list = componentProposalsOf(componentSightings.value.filter((s) => s.locationUuid === location)).filter(kept);
    const held = componentsInStock(list, batches.value, location, registered.value);
    return list.map((p) => ({ ...p, locationUuid: location, inStock: held.has(p.id) }));
  }),
);

/** What the debug window shows: the sightings of both scans, which of them were registered or discarded and their locations' names. */
export interface SightingsReport {
  materials: Located<Sighting>[];
  components: Located<ComponentSighting>[];
  registered: string[];
  dismissed: string[];
  // Location UUID -> short name (the debug window has no catalog)
  locations: Record<string, string>;
  // Every stat name the component scan matches tooltip lines against (normalized, every language)
  statNames: string[];
}

const newestFirst = (a: { atMs: number }, b: { atMs: number }) => b.atMs - a.atMs;

// The debug window shows the sightings too: it gets them with every change and on request
const publish = () => {
  sightings.value = [...scans].flatMap(([location, at]) => located(location, at.stacks.list())).sort(newestFirst);
  componentSightings.value = [...scans].flatMap(([location, at]) => located(location, at.components.list())).sort(newestFirst);
  const used = new Set(scans.keys());
  const locations = Object.fromEntries((syncCatalog.value?.locations ?? []).filter((l) => used.has(l.uuid)).map((l) => [l.uuid, l.short]));
  const statNames = [...new Set([...(syncCatalog.value?.components.statNames.values() ?? [])].flatMap((names) => [...names]))];
  const report: SightingsReport = { materials: sightings.value, components: componentSightings.value, registered: [...registered.value], dismissed: [...dismissed.value], locations, statNames };
  void emit("inventory-sightings", report).catch(() => undefined);
};

export async function loadStock() {
  batches.value = (await api<StockListResponse>("GET", "/stock?scope=personal&lang=en")).batches;
}

// One event at a time
let queue = Promise.resolve();
const serial = (work: () => Promise<void>) => {
  queue = queue.then(work).catch(toastError);
};

function onRead(e: InventoryReadEvent) {
  serial(async () => {
    // A read belongs to the location picked now
    const location = locationUuid.value;
    if (!connected.value || !location) return;
    await ensureCatalog();
    const cat = syncCatalog.value!;
    const at = scansAt(location);
    let changed = false;
    if (e.grid) {
      const inventoryCatalog = { materials: cat.allMaterials, units: cat.units, components: new Set(cat.components.components.map((c) => c.uuid)) };
      changed = !!at.stacks.feed(e, inventoryCatalog, (s) => kinds.value.has(s.unit === "SCU" ? "mats" : "items"));
    }
    if (e.components) {
      // An unknown title (no kind yet) only while either gear kind is on (it is listed in the debug window)
      const accept = (s: ComponentSighting) => (s.fps === null ? kinds.value.has("comps") || kinds.value.has("fps") : kinds.value.has(s.fps ? "fps" : "comps"));
      changed = !!at.components.feed(e.atMs, e.components, cat.components, accept, e.capture.restMs) || changed;
    }
    if (changed) publish();
  });
}

/** Drops every location's sightings (the scan starts afresh). */
export function resetSightings() {
  scans.clear();
  dismissed.value = new Set();
  registered.value = new Set();
  publish();
}

export async function watchInventory() {
  await listen<InventoryReadEvent>("inventory-read", (e) => onRead(e.payload));
  await listen("inventory-sightings-request", () => publish());
}

// The orgs the user shares registered stacks in (the dialog's switches; kept for the session)
export const shareGuildIds = ref<string[]>([]);

/** Books a stack proposal at its location, shared in `shareGuildIds`; true when done. The sighting stays, marked registered. */
export async function accept(p: Located<Proposal>): Promise<boolean> {
  try {
    await api<OkResponse>("POST", "/stock/add", addRequest(p, p.locationUuid, shareGuildIds.value));
    registered.value = new Set([...registered.value, p.id]);
    publish();
    return true;
  } catch (e) {
    toastError(e);
    return false;
  } finally {
    await loadStock().catch(toastError);
  }
}

/** Books a gear proposal at its location (its pieces, its stats), shared in `shareGuildIds`; true when done. */
export async function acceptComponent(p: Located<ComponentProposal>): Promise<boolean> {
  try {
    await api<OkResponse>("POST", "/stock/add", componentRequest(p, p.locationUuid, shareGuildIds.value));
    registered.value = new Set([...registered.value, p.id]);
    publish();
    return true;
  } catch (e) {
    toastError(e);
    return false;
  } finally {
    // The pieces stored now: the same component's other tiles count against them
    await loadStock().catch(toastError);
  }
}

export function dismiss(id: string) {
  dismissed.value = new Set([...dismissed.value, id]);
  publish();
}
