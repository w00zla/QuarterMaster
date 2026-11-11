// The singleuser variant's own state: the game data update (GET /api/local/data), the settings and the UEX pull. The data
// state is polled (every second while it is busy or a request failed, else rarely) because the browser is not told: it
// feeds the start tile, the bold notice and the settings view. Only started with `login: 'none'`.
import { computed, ref, watch } from "vue";
import type { DataUpdateState, LocalSettingsState, LocalSettingsUpdate, UexState } from "../../src/webapp/api-types";
import { api } from "./api";
import { loadCapabilities, loginNone } from "./capabilities";
import { appTooOld, isBusy } from "./settingsLogic";
import { tileModel } from "./startTile";

/** The last state that came in; a failed request leaves it as it was. */
export const data = ref<DataUpdateState | null>(null);
/** State requests that failed or timed out since the last good one. */
export const failedPolls = ref(0);
export const settings = ref<LocalSettingsState | null>(null);
export const uex = ref<UexState | null>(null);

/** The installed data pack's tag: undefined = not known yet, null = none installed. */
export const installedTag = computed(() => (data.value ? (data.value.installed?.tag ?? null) : undefined));

export const tile = computed(() => loginNone.value
  ? tileModel({ data: data.value, failedPolls: failedPolls.value, autoUpdate: settings.value?.autoUpdate ?? null })
  : ({ visible: false } as const));

/** The bold notice above every view. */
export const updateNeeded = computed(() => loginNone.value && appTooOld(data.value));

const BUSY_MS = 1000;
const IDLE_MS = 15_000;
// The catalog import blocks the whole process for a few seconds: a request that gets no answer by then is "busy", not "broken"
const TIMEOUT_MS = 3000;

async function withTimeout<T>(call: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    return await call(ctl.signal);
  } finally {
    clearTimeout(timer);
  }
}

export async function refreshData(): Promise<void> {
  try {
    data.value = await withTimeout((signal) => api<DataUpdateState>("/local/data", { signal }));
    failedPolls.value = 0;
  } catch {
    failedPolls.value++;
  }
}

export async function loadSettings(): Promise<void> {
  try {
    settings.value = await api<LocalSettingsState>("/local/settings");
  } catch { /* the view shows what it has */ }
}

export async function refreshUex(): Promise<void> {
  try {
    uex.value = await api<UexState>("/local/uex");
  } catch { /* as it was */ }
}

/** Stores settings; throws ApiError (422 gameFolderInvalid, 409 overridden, 400). A new UEX key changes the capabilities at once. */
export async function saveSettings(update: LocalSettingsUpdate): Promise<void> {
  settings.value = await api<LocalSettingsState>("/local/settings", { method: "PUT", body: update });
  if (update.uexKey !== undefined) {
    void loadCapabilities();
    await refreshUex();
  } else if (update.uexIntervalMinutes !== undefined) await refreshUex();
}

export async function pullUex(): Promise<void> {
  uex.value = await api<UexState>("/local/uex/pull", { method: "POST", body: {} });
}

export async function checkData(): Promise<void> {
  data.value = await api<DataUpdateState>("/local/data/check", { method: "POST", body: {} });
  failedPolls.value = 0;
  kick();
}

export async function importData(path: string): Promise<void> {
  data.value = await api<DataUpdateState>("/local/data/import", { method: "POST", body: { path } });
  failedPolls.value = 0;
  kick();
}

let timer: ReturnType<typeof setTimeout> | undefined;
let started = false;

function schedule(ms: number) {
  clearTimeout(timer);
  timer = setTimeout(() => void tick(), ms);
}

/** Polls sooner: after an action that starts something. */
function kick() {
  if (started) schedule(BUSY_MS);
}

async function tick() {
  await refreshData();
  const busy = isBusy(data.value) || failedPolls.value > 0;
  // Now and then the capabilities too: the game version follows a data install
  if (!busy) void loadCapabilities();
  schedule(busy ? BUSY_MS : IDLE_MS);
}

/** Starts the polling (once). */
export function startLocal() {
  if (started) return;
  started = true;
  void loadSettings();
  void tick();
}

// A new data pack: the game version of the top bar follows
watch(installedTag, (tag, old) => {
  if (old !== undefined && tag !== old) void loadCapabilities();
});
