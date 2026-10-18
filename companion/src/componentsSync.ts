// The ship component scan in the app: the OCR's reads of the character inventory (Rust event
// "components-read") go through ComponentScan (components.ts) into sightings; each complete sighting
// is a proposal (one piece per tile, with the gains read off the tooltip), which waits until the user
// registers or dismisses it. The location is picked before a session starts and kept (localStorage).
// Starting a session clears the sightings of the one before. The catalog (components, stat names in
// both languages plus the player's language pack) is the refinery sync's; the orgs to share in are
// the warehouse scan's choice.
import { listen } from "@tauri-apps/api/event";
import { computed, ref } from "vue";
import type { OkResponse } from "../../src/webapp/api-types";
import { addRequest, ComponentScan, proposalsOf, type ComponentProposal, type ComponentReadEvent, type ComponentSighting } from "./components";
import { shareGuildIds } from "./inventorySync";
import { ensureCatalog, syncCatalog } from "./refinerySync";
import { startScan, stopScan } from "./scan";
import { api, connected } from "./state";
import { toastError } from "./toasts";

const LOCATION_KEY = "qm.companion.components.location";

const scan = new ComponentScan();
export const sightings = ref<ComponentSighting[]>([]);
export const locationUuid = ref<string | null>(localStorage.getItem(LOCATION_KEY));
const dismissed = ref(new Set<string>());

export function setLocation(uuid: string | null) {
  locationUuid.value = uuid;
  if (uuid) localStorage.setItem(LOCATION_KEY, uuid);
  else localStorage.removeItem(LOCATION_KEY);
}

export const proposals = computed<ComponentProposal[]>(() => proposalsOf(sightings.value).filter((p) => !dismissed.value.has(p.id)));
// The sightings that yield no proposal (unknown component, unreadable stats), newest first
export const problems = computed(() => sightings.value.filter((s) => s.problem && !dismissed.value.has(s.key)));

const publish = () => (sightings.value = scan.list());

// One event at a time
let queue = Promise.resolve();
const serial = (work: () => Promise<void>) => {
  queue = queue.then(work).catch(toastError);
};

function onRead(e: ComponentReadEvent) {
  serial(async () => {
    if (!connected.value) return;
    await ensureCatalog();
    if (scan.feed(e, syncCatalog.value!.components)) publish();
  });
}

/** Starts a components session for the chosen location: the earlier sightings go. */
export async function startComponentsScan() {
  if (!locationUuid.value) return;
  scan.clear();
  dismissed.value = new Set();
  publish();
  try {
    await ensureCatalog();
  } catch (e) {
    toastError(e);
  }
  await startScan("components");
}

export const stopComponentsScan = () => stopScan();

export async function watchComponents() {
  await listen<ComponentReadEvent>("components-read", (e) => onRead(e.payload));
}

/** Books a proposal, shared in `shareGuildIds`; true when done. The sighting goes with it. */
export async function accept(p: ComponentProposal): Promise<boolean> {
  if (!locationUuid.value) return false;
  try {
    await api<OkResponse>("POST", "/stock/add", addRequest(p, locationUuid.value, shareGuildIds.value));
    scan.sightings.delete(p.id);
    publish();
    return true;
  } catch (e) {
    toastError(e);
    return false;
  }
}

export function dismiss(id: string) {
  dismissed.value = new Set([...dismissed.value, id]);
}
