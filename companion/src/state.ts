// Config, connection and Game.log state, shared by the views. The connection state follows every
// API call (see api below) and is re-checked while it is down; calls that take a while show as
// loading (loadingTexts).
import { computed, ref } from "vue";
import { listen } from "@tauri-apps/api/event";
import type { MeResponse } from "../../src/webapp/api-types";
import { api as backendApi, getConfig, isConnectionError, logState, outdated, type Config, type LogState } from "./backend";
import { applyLangSetting, t } from "./i18n";
import { errorText, toastError } from "./toasts";

// Re-check interval while not connected
const RETRY_MS = 30_000;

export const config = ref<Config | null>(null);
// Server and token set and accepted (GET /api/me answered)
export const connected = ref(false);
// The token's user (Discord name and avatar as of the login that created the token), null while unknown
export const meName = ref<string | null>(null);
export const meAvatar = ref<string | null>(null);
// The user's active orgs (the inventory scan offers to share registered stacks in them)
export const meOrgs = ref<MeResponse["orgs"]>([]);
// Why the connection is down (error code), null when connected or nothing checked yet
export const connectError = ref<unknown>(null);
// The followed Game.log and its unlocks
export const log = ref<LogState | null>(null);

/** The connection as one line ("Connection successful" or why not). */
export const connectionText = computed(() => (connected.value ? t("conn.ok")
  : connectError.value ? errorText(connectError.value) : t("conn.off")));

/** Takes a config in (loaded or saved) and applies its language. */
export function applyConfig(c: Config) {
  config.value = c;
  applyLangSetting(c.language);
}

export async function loadConfig() {
  applyConfig(await getConfig());
}

// The state row's loading tag: the calls running longer than LOADING_DELAY_MS (quick ones never show: no
// flicker), each with what it loads
const LOADING_DELAY_MS = 400;
const loads = ref(new Map<number, string>());
let nextLoad = 0;

/** What a call loads, for the tag's tooltip ("Catalog (de)", "Stock", "Saving"). */
function loadText(method: "GET" | "POST", path: string): string {
  if (method === "POST") return t("load.save");
  const [route = "", query = ""] = path.slice(1).split("?");
  const lang = new URLSearchParams(query).get("lang");
  switch (route.split("/")[0]) {
    case "catalog": return t("load.catalog", { lang: lang ?? "" });
    case "stock": return t("load.stock");
    case "blueprints": return t("load.blueprints");
    case "me": return t("load.me");
    default: return t("load.other");
  }
}

// What is loading now (distinct texts), empty when nothing runs long enough to show
export const loadingTexts = computed(() => [...new Set(loads.value.values())]);

/** One web app API call; a refusal of the connection itself (server, token, version) marks it down. */
export async function api<T>(method: "GET" | "POST", path: string, body?: unknown, cache = false): Promise<T> {
  const id = nextLoad++;
  const timer = setTimeout(() => (loads.value = new Map(loads.value).set(id, loadText(method, path))), LOADING_DELAY_MS);
  try {
    return await backendApi<T>(method, path, body, cache);
  } catch (e) {
    if (isConnectionError(e)) {
      connected.value = false;
      connectError.value = e;
    }
    throw e;
  } finally {
    clearTimeout(timer);
    if (loads.value.has(id)) {
      const next = new Map(loads.value);
      next.delete(id);
      loads.value = next;
    }
  }
}

/** Checks server and token with GET /api/me (also clears an update hint the server dropped). */
export async function refreshConnection() {
  if (!config.value?.server || !config.value.token) {
    connected.value = false;
    meName.value = null;
    meAvatar.value = null;
    connectError.value = config.value?.server ? "noToken" : "noServer";
    return;
  }
  try {
    const me = await api<MeResponse>("GET", "/me");
    meName.value = me.name;
    meAvatar.value = me.avatarUrl;
    meOrgs.value = me.orgs;
    connectError.value = null;
    outdated.value = null;
    connected.value = true;
  } catch (e) {
    connected.value = false;
    connectError.value = e;
  }
}

// The refresh button: what each part of the app reloads (catalog, stock, jobs, blueprints), after the connection
const refreshers = new Set<() => Promise<void>>();
export const refreshing = ref(false);

/** Adds a reload to the refresh button; returns its removal. */
export function onRefresh(reload: () => Promise<void>) {
  refreshers.add(reload);
  return () => void refreshers.delete(reload);
}

/** Checks the connection (user, orgs), then runs every reload; a failing one is toasted, the rest still run. */
export async function refreshAll() {
  if (refreshing.value) return;
  refreshing.value = true;
  try {
    await refreshConnection();
    if (connected.value) for (const reload of refreshers) await reload().catch(toastError);
  } finally {
    refreshing.value = false;
  }
}

/** Re-checks the connection every RETRY_MS while it is down, and whenever the window gets focus. */
export function watchConnection() {
  setInterval(() => {
    if (!connected.value) void refreshConnection();
  }, RETRY_MS);
  window.addEventListener("focus", () => void refreshConnection());
}

export async function loadLog() {
  try {
    log.value = await logState();
  } catch (e) {
    toastError(e);
  }
}

/** Follows the Rust side's log changes (new unlocks, Game.log found or gone). */
export async function watchLog() {
  await listen("log-changed", () => void loadLog());
  await loadLog();
}
