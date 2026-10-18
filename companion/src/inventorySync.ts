// The inventory scan in the app: the OCR's reads (Rust event "inventory-read") go through
// InventoryScan (inventory.ts: the freight manager's warehouse, materials and items) and
// ComponentScan (components.ts: the character inventory, ship components) into sightings; each
// complete sighting is a proposal (one per stack, with what the user's stored stock at the chosen
// location already holds of that material and quality; one per component tile), which waits until
// the user registers or dismisses it. The kind filter (Mats / Items / Comps, kept in localStorage)
// decides what is detected at all. The location is picked before a session starts and kept. Starting
// a session clears the sightings of the one before. The catalog (names in both languages plus the
// player's language pack) is the refinery sync's.
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

const scan = new InventoryScan();
const componentScan = new ComponentScan();
export const sightings = ref<Sighting[]>([]);
export const componentSightings = ref<ComponentSighting[]>([]);
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
export const proposals = computed<Proposal[]>(() =>
  locationUuid.value ? proposalsOf(sightings.value, batches.value, locationUuid.value).filter((p) => open(p.id)) : [],
);
export const componentProposals = computed<ComponentProposal[]>(() => componentProposalsOf(componentSightings.value).filter((p) => open(p.id)));

/** What the debug window shows: the sightings of both scans and which of them were registered or discarded. */
export interface SightingsReport {
  materials: Sighting[];
  components: ComponentSighting[];
  registered: string[];
  dismissed: string[];
}

// The debug window shows the sightings too: it gets them with every change and on request
const publish = () => {
  sightings.value = scan.list();
  componentSightings.value = componentScan.list();
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
    if (!connected.value) return;
    await ensureCatalog();
    const cat = syncCatalog.value!;
    let changed = false;
    if (e.grid) {
      const inventoryCatalog = { materials: cat.allMaterials, units: cat.units, components: new Set(cat.components.components.map((c) => c.uuid)) };
      changed = !!scan.feed(e, inventoryCatalog, (s) => kinds.value.has(s.unit === "SCU" ? "mats" : "items"));
    }
    if (e.components) {
      changed = !!componentScan.feed(e.atMs, e.components, cat.components, () => kinds.value.has("comps")) || changed;
    }
    if (changed) publish();
  });
}

/** Starts an inventory session for the chosen location: the earlier sightings go. */
export async function startInventoryScan() {
  if (!locationUuid.value) return;
  scan.clear();
  componentScan.clear();
  dismissed.value = new Set();
  registered.value = new Set();
  publish();
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

/** Books a stack proposal, shared in `shareGuildIds`; true when done. The sighting stays, marked registered. */
export async function accept(p: Proposal): Promise<boolean> {
  if (!locationUuid.value) return false;
  try {
    await api<OkResponse>("POST", "/stock/add", addRequest(p, locationUuid.value, shareGuildIds.value));
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

/** Books a component proposal (one piece, its stats), shared in `shareGuildIds`; true when done. */
export async function acceptComponent(p: ComponentProposal): Promise<boolean> {
  if (!locationUuid.value) return false;
  try {
    await api<OkResponse>("POST", "/stock/add", componentRequest(p, locationUuid.value, shareGuildIds.value));
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
