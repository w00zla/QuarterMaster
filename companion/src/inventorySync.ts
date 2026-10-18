// The inventory scan in the app: the OCR's reads (Rust event "inventory-read") go through
// InventoryScan (inventory.ts) into sightings; each complete sighting is a proposal (one per stack,
// with what the user's stored stock at the chosen location already holds of that material and
// quality), which waits until the user registers or dismisses it. The location is picked before a
// session starts and kept (localStorage). Starting a session clears the sightings of the one before.
// The catalog (names in both languages plus the player's language pack) is the refinery sync's.
import { emit, listen } from "@tauri-apps/api/event";
import { computed, ref } from "vue";
import type { OkResponse, StockBatch, StockListResponse } from "../../src/webapp/api-types";
import { addRequest, InventoryScan, proposalsOf, type InventoryReadEvent, type Proposal, type Sighting } from "./inventory";
import { ensureCatalog, syncCatalog } from "./refinerySync";
import { startScan, stopScan } from "./scan";
import { api, connected } from "./state";
import { toastError } from "./toasts";

const LOCATION_KEY = "qm.companion.inventory.location";

const scan = new InventoryScan();
export const sightings = ref<Sighting[]>([]);
export const locationUuid = ref<string | null>(localStorage.getItem(LOCATION_KEY));
const batches = ref<StockBatch[]>([]);
const dismissed = ref(new Set<string>());

export function setLocation(uuid: string | null) {
  locationUuid.value = uuid;
  if (uuid) localStorage.setItem(LOCATION_KEY, uuid);
  else localStorage.removeItem(LOCATION_KEY);
}

export const proposals = computed<Proposal[]>(() =>
  locationUuid.value ? proposalsOf(sightings.value, batches.value, locationUuid.value).filter((p) => !dismissed.value.has(p.id)) : [],
);

// The debug window shows the sightings too: it gets them with every change and on request
const publish = () => {
  sightings.value = scan.list();
  void emit("inventory-sightings", sightings.value).catch(() => undefined);
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
    if (scan.feed(e, { materials: cat.allMaterials, units: cat.units })) publish();
  });
}

/** Starts an inventory session for the chosen location: the earlier sightings go. */
export async function startInventoryScan() {
  if (!locationUuid.value) return;
  scan.clear();
  dismissed.value = new Set();
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

/** Books a proposal, shared in `shareGuildIds`; true when done. The sighting goes with it. */
export async function accept(p: Proposal): Promise<boolean> {
  if (!locationUuid.value) return false;
  try {
    await api<OkResponse>("POST", "/stock/add", addRequest(p, locationUuid.value, shareGuildIds.value));
    scan.sightings.delete(p.id);
    publish();
    return true;
  } catch (e) {
    toastError(e);
    return false;
  } finally {
    await loadStock().catch(toastError);
  }
}

export function dismiss(p: Proposal) {
  dismissed.value = new Set([...dismissed.value, p.id]);
}
