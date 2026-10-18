// The inventory scan in the app: the OCR's reads (Rust event "inventory-read") go through
// InventoryScan (inventory.ts: the freight manager's warehouse, materials and items) and
// ComponentScan (components.ts: the character inventory, ship components) into sightings; each
// complete sighting is a proposal (one per stack, with what the user's stored stock at its location
// already holds of that material and quality; one per component tile), which waits until the user
// registers or dismisses it. The kind filter (Mats / Items / Comps, kept in localStorage) decides
// what is detected at all. Every location collects its own sightings: the location picked (kept,
// changeable while scanning: the player walks from one warehouse to the next) is where a read
// belongs, and a proposal is registered at its own location. Starting a session clears the sightings
// of the one before. The catalog (names in both languages plus the player's language pack) is the
// refinery sync's.
import { emit, listen } from "@tauri-apps/api/event";
import { computed, ref } from "vue";
import type { OkResponse, StockBatch, StockListResponse } from "../../src/webapp/api-types";
import { addRequest as componentRequest, ComponentScan, proposalsOf as componentProposalsOf, type ComponentProposal, type ComponentSighting } from "./components";
import { addRequest, InventoryScan, proposalsOf, type InventoryReadEvent, type Proposal, type Sighting } from "./inventory";
import { ensureCatalog, syncCatalog } from "./refinerySync";
import { startScan, stopScan } from "./scan";
import { api, connected } from "./state";
import { toastError } from "./toasts";

const LOCATION_KEY = "qm.companion.inventory.location";
const KINDS_KEY = "qm.companion.inventory.kinds";

export type Kind = "mats" | "items" | "comps";
export const KINDS: Kind[] = ["mats", "items", "comps"];
// Each kind's tag colour and icon (panel rows, filter chips, the overlay's head)
export const KIND_CLASS = { mats: "ok", items: "", comps: "accent" } as const satisfies Record<Kind, string>;
export const KIND_ICON = { mats: "resource", items: "item", comps: "type-module" } as const satisfies Record<Kind, string>;

/** A sighting or proposal with the location it belongs to (its key and id unique across locations). */
export type Located<T> = T & { locationUuid: string };

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

function storedKinds(): Set<Kind> {
  try {
    const list = JSON.parse(localStorage.getItem(KINDS_KEY) ?? "null") as unknown;
    if (Array.isArray(list)) {
      const kinds = new Set(list.filter((k): k is Kind => KINDS.includes(k as Kind)));
      if (kinds.size) return kinds;
    }
  } catch {
    // Not valid: every kind
  }
  return new Set(KINDS);
}

// What the scan detects; a change applies to the reads from then on
export const kinds = ref<Set<Kind>>(storedKinds());

export function toggleKind(kind: Kind) {
  const next = new Set(kinds.value);
  if (next.has(kind)) next.delete(kind);
  else next.add(kind);
  if (!next.size) return;
  kinds.value = next;
  localStorage.setItem(KINDS_KEY, JSON.stringify([...next]));
}

export function setLocation(uuid: string | null) {
  locationUuid.value = uuid;
  if (uuid) localStorage.setItem(LOCATION_KEY, uuid);
  else localStorage.removeItem(LOCATION_KEY);
}

const open = (id: string) => !dismissed.value.has(id) && !registered.value.has(id);
const locationsOf = (list: { locationUuid: string }[]) => [...new Set(list.map((s) => s.locationUuid))];
// Per location: its sightings against its stored stock
export const proposals = computed<Located<Proposal>[]>(() =>
  locationsOf(sightings.value).flatMap((location) =>
    proposalsOf(sightings.value.filter((s) => s.locationUuid === location), batches.value, location).map((p) => ({ ...p, locationUuid: location })),
  ).filter((p) => open(p.id)),
);
export const componentProposals = computed<Located<ComponentProposal>[]>(() =>
  locationsOf(componentSightings.value).flatMap((location) =>
    componentProposalsOf(componentSightings.value.filter((s) => s.locationUuid === location)).map((p) => ({ ...p, locationUuid: location })),
  ).filter((p) => open(p.id)),
);

/** What the debug window shows: the sightings of both scans and which of them were registered or discarded. */
export interface SightingsReport {
  materials: Sighting[];
  components: ComponentSighting[];
  registered: string[];
  dismissed: string[];
}

const newestFirst = (a: { atMs: number }, b: { atMs: number }) => b.atMs - a.atMs;

// The debug window shows the sightings too: it gets them with every change and on request
const publish = () => {
  sightings.value = [...scans].flatMap(([location, at]) => located(location, at.stacks.list())).sort(newestFirst);
  componentSightings.value = [...scans].flatMap(([location, at]) => located(location, at.components.list())).sort(newestFirst);
  const report: SightingsReport = { materials: sightings.value, components: componentSightings.value, registered: [...registered.value], dismissed: [...dismissed.value] };
  void emit("inventory-sightings", report).catch(() => undefined);
};

async function loadStock() {
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
      changed = !!at.components.feed(e.atMs, e.components, cat.components, () => kinds.value.has("comps")) || changed;
    }
    if (changed) publish();
  });
}

/** Starts an inventory session for the chosen location: the earlier sightings go, unless `fresh` is
 * false (the overlay's mode switching back to the inventory resumes). */
export async function startInventoryScan(fresh = true) {
  if (!locationUuid.value) return;
  if (fresh) {
    scans.clear();
    dismissed.value = new Set();
    registered.value = new Set();
    publish();
  }
  try {
    await ensureCatalog();
    await loadStock();
  } catch (e) {
    toastError(e);
  }
  await startScan("inventory");
}

export const stopInventoryScan = () => stopScan();

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

/** Books a component proposal at its location (one piece, its stats), shared in `shareGuildIds`; true when done. */
export async function acceptComponent(p: Located<ComponentProposal>): Promise<boolean> {
  try {
    await api<OkResponse>("POST", "/stock/add", componentRequest(p, p.locationUuid, shareGuildIds.value));
    registered.value = new Set([...registered.value, p.id]);
    publish();
    return true;
  } catch (e) {
    toastError(e);
    return false;
  }
}

export function dismiss(id: string) {
  dismissed.value = new Set([...dismissed.value, id]);
  publish();
}
