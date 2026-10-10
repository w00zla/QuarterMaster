// The refinery sync in the app: the OCR's reads of a terminal's overview (Rust events
// "refinery-overview" and "refinery-visit") go through RefinerySync (refinery.ts) against the user's
// running jobs. Matched running jobs are updated right away; proposals wait in the list until the user
// confirms or dismisses them. Names are resolved against the web app's catalog in both languages and
// the player's own language pack (the terminal shows its texts).
import { listen } from "@tauri-apps/api/event";
import { ref, shallowRef, watch } from "vue";
import type { CatalogResponse, OkResponse, StockListResponse } from "../../src/webapp/api-types";
import { gameNames, getDetect, getGameSeen, setDetect } from "./backend";
import { t } from "./i18n";
import {
  buildCatalog, doneRequest, gameNameKeys, jobsOf, RefinerySync, removeRequest, startRequest,
  type Job, type OverviewEvent, type Proposal, type SyncCatalog, type Update, type VisitEvent,
} from "./refinery";
import { api, config, connected } from "./state";
import { toast, toastError } from "./toasts";

const sync = new RefinerySync();
export const proposals = ref<Proposal[]>([]);
// Detection on (on at every start; the state row's toggle switches it)
export const detecting = ref(true);
// Star Citizen runs (seen by the screen capture while detection is on)
export const gameSeen = ref(false);
export const syncCatalog = shallowRef<SyncCatalog | null>(null);
// The catalog and the player's language pack are being loaded (the state row shows it)
export const preparing = ref(false);
let jobs: Job[] = [];

export async function toggleDetect() {
  try {
    await setDetect(!detecting.value);
    detecting.value = await getDetect();
  } catch (e) {
    toastError(e);
  }
}

const publish = () => (proposals.value = [...sync.proposals]);

/** The catalog lookups plus the player's language pack texts: once at the start (when connected) and again when
 * the game folder changes. */
async function loadCatalog() {
  preparing.value = true;
  try {
    const responses: CatalogResponse[] = [];
    for (const l of ["de", "en"]) responses.push(await api<CatalogResponse>("GET", `/catalog?lang=${l}`));
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

async function loadJobs() {
  jobs = jobsOf((await api<StockListResponse>("GET", "/stock?scope=personal&lang=en")).batches);
  sync.prune(jobs);
  publish();
}

export const stationName = (uuid: string) => syncCatalog.value?.stationNames.get(uuid) ?? "?";
export const materialName = (uuid: string) => syncCatalog.value?.materialNames.get(uuid) ?? "?";

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
  detecting.value = await getDetect();
  gameSeen.value = await getGameSeen();
  await listen<boolean>("game-seen", (e) => {
    gameSeen.value = e.payload;
  });
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
    else await api<OkResponse>("POST", "/refinery/remove", removeRequest(p.job));
    sync.drop(p.id);
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
