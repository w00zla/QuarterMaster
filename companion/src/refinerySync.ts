// The refinery sync in the app: the OCR's reads of a terminal's overview (Rust events
// "refinery-overview" and "refinery-visit") go through RefinerySync (refinery.ts) against the user's
// running jobs. Matched running jobs are updated right away; proposals wait in the list until the user
// confirms or dismisses them. Names are resolved against the web app's catalog in both languages and
// the player's own language pack (the terminal shows its texts); the catalog is shared with the
// inventory scan (inventorySync.ts). The filter "Jobs" (kept, on by default) decides whether the scan
// reads the terminal at all; the scan itself is in scan.ts.
import { listen } from "@tauri-apps/api/event";
import { computed, ref, shallowRef, watch } from "vue";
import type { CatalogResponse, OkResponse, StockListResponse } from "../../src/webapp/api-types";
import { gameNames } from "./backend";
import { t } from "./i18n";
import {
  buildCatalog, doneRequest, finishedRequests, gameNameKeys, jobsOf, RefinerySync, removeRequest, startRequest,
  type Job, type OverviewEvent, type Proposal, type SyncCatalog, type Update, type VisitEvent,
} from "./refinery";
import { api, config, connected } from "./state";
import { thumbRef } from "./thumbs";
import { toast, toastError } from "./toasts";

// Completed orders already stored, with when (kept: the terminal shows them until they are collected in
// the game, also after a restart of the app); forgotten after STORED_DAYS
const STORED_KEY = "qm.companion.refinery.stored";
const STORED_DAYS = 30;
function loadStored(): Map<string, number> {
  try {
    const list = JSON.parse(localStorage.getItem(STORED_KEY) ?? "[]") as [string, number][];
    const since = Date.now() - STORED_DAYS * 86_400_000;
    return new Map(list.filter(([, at]) => at >= since));
  } catch {
    return new Map();
  }
}
const storedAt = loadStored();
const sync = new RefinerySync(storedAt.keys());

function saveStored() {
  for (const key of sync.stored) if (!storedAt.has(key)) storedAt.set(key, Date.now());
  localStorage.setItem(STORED_KEY, JSON.stringify([...storedAt]));
}

// A completed order without a job is stored row by row: the rows already added (a retry after a failed
// row adds only the rest)
const finishedRows = new Map<string, number>();
export const proposals = ref<Proposal[]>([]);
export const syncCatalog = shallowRef<SyncCatalog | null>(null);
// The catalog as the web app answered it, per language (the unlocks panel's blueprints): fetched once with syncCatalog
export const catalogResponses = shallowRef<Record<"de" | "en", CatalogResponse> | null>(null);
// The catalog and the player's language pack are being loaded (the state row shows it)
export const preparing = ref(false);
let jobs: Job[] = [];

const JOBS_KEY = "qm.companion.refinery.jobs";
// The filter: whether the scan reads the refinery terminal
export const jobsOn = ref(localStorage.getItem(JOBS_KEY) !== "0");

export function toggleJobs() {
  jobsOn.value = !jobsOn.value;
  localStorage.setItem(JOBS_KEY, jobsOn.value ? "1" : "0");
}

const publish = () => (proposals.value = [...sync.proposals]);

/** The catalog lookups plus the player's language pack texts: once at the start (when connected) and again when
 * the game folder changes. The only place the companion fetches the catalog. */
async function loadCatalog() {
  preparing.value = true;
  try {
    // Kept on disk and revalidated by its ETag: an unchanged catalog costs no transfer
    const de = await api<CatalogResponse>("GET", "/catalog?lang=de", undefined, true);
    const en = await api<CatalogResponse>("GET", "/catalog?lang=en", undefined, true);
    const responses = [de, en];
    catalogResponses.value = { de, en };
    let own: Record<string, string> = {};
    try {
      own = await gameNames(gameNameKeys(responses));
    } catch (e) {
      // Without the pack the catalog's names still work
      console.warn("game names:", e);
    }
    syncCatalog.value = buildCatalog(responses, own);
  } finally {
    preparing.value = false;
  }
}

/** The catalog, loaded when missing. */
export async function ensureCatalog() {
  if (!syncCatalog.value) await loadCatalog();
}

async function loadJobs() {
  jobs = jobsOf((await api<StockListResponse>("GET", "/stock?scope=personal&lang=en")).batches);
  sync.prune(jobs);
  publish();
}

export const stationName = (uuid: string) => syncCatalog.value?.stationNames.get(uuid) ?? "?";
export const materialName = (uuid: string) => syncCatalog.value?.materialNames.get(uuid) ?? "?";
// The catalog's thumbnail hashes per material and item (the same in both languages)
const thumbHashes = computed(() => new Map((catalogResponses.value?.en.materials ?? []).map((m) => [m.uuid, m.thumb])));
/** A material's or item's thumbnail, null when the catalog has none. */
export const materialThumb = (uuid: string) => thumbRef(uuid, thumbHashes.value.get(uuid));

// One event at a time: a read waits for the writes of the one before
let queue = Promise.resolve();
const serial = (work: () => Promise<void>) => {
  queue = queue.then(work).catch(toastError);
};

async function apply(updates: Update[], locationUuid: string) {
  const changed = new Set<string>();
  for (const u of updates) {
    if (u.kind === "yield") await api<OkResponse>("POST", "/stock/adjust", { batchId: u.batchId, amount: u.amount, expected: u.expected });
    else await api<OkResponse>("POST", "/refinery/duration", { jobId: u.jobId, durationSeconds: u.durationSeconds });
    changed.add(t(u.kind === "yield" ? "refinery.what.yield" : "refinery.what.time"));
  }
  toast(t("refinery.updated", { station: stationName(locationUuid), what: [...changed].join(", ") }));
}

function onOverview(e: OverviewEvent) {
  serial(async () => {
    if (!connected.value) return;
    if (!syncCatalog.value) {
      await loadCatalog();
      await loadJobs();
    }
    const result = sync.feed(e, syncCatalog.value!, jobs, Date.now());
    if (!result.locationUuid) console.warn("refinery station not recognized:", e.overview.station);
    else if (result.updates.length) {
      try {
        await apply(result.updates, result.locationUuid);
      } finally {
        await loadJobs();
      }
    }
    publish();
  });
}

function onVisit(e: VisitEvent) {
  serial(async () => {
    if (!connected.value) return;
    if (e.active) {
      sync.startVisit();
      await loadJobs();
    } else {
      await loadJobs();
      sync.endVisit(jobs);
      publish();
    }
  });
}

export async function watchRefinery() {
  await listen<OverviewEvent>("refinery-overview", (e) => onOverview(e.payload));
  await listen<VisitEvent>("refinery-visit", (e) => onVisit(e.payload));
  // Ready before the first visit: loaded once connected (the catalog comes from the server), again for another game folder
  let loadedFor: string | null = null;
  watch([connected, () => config.value?.gameDir], ([c, dir]) => {
    if (!c || dir === undefined || dir === loadedFor) return;
    loadedFor = dir;
    serial(loadCatalog);
  }, { immediate: true });
}

// --- the user's answers to proposals ---------------------------------------------------------------

/** Carries out a proposal (register, store, remove); true when done. */
export async function accept(p: Proposal): Promise<boolean> {
  try {
    if (p.kind === "new") await api<OkResponse>("POST", "/refinery/start", startRequest(p, Date.now()));
    else if (p.kind === "store") await api<OkResponse>("POST", "/refinery/done", doneRequest(p));
    else if (p.kind === "finished") {
      const requests = finishedRequests(p);
      for (let i = finishedRows.get(p.id) ?? 0; i < requests.length; i++) {
        await api<OkResponse>("POST", "/stock/add", requests[i]);
        finishedRows.set(p.id, i + 1);
      }
    } else await api<OkResponse>("POST", "/refinery/remove", removeRequest(p.job));
    if (p.kind === "store" || p.kind === "finished") {
      sync.markStored(p);
      saveStored();
    } else sync.drop(p.id);
    return true;
  } catch (e) {
    toastError(e);
    return false;
  } finally {
    await loadJobs().catch(toastError);
  }
}

export function dismiss(p: Proposal) {
  sync.dismiss(p.id);
  publish();
}
