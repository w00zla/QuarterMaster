// Config, connection and Game.log state, shared by the views. The connection state follows every
// API call (see api below) and is re-checked while it is down; calls that take a while show as
// loading (loadingTexts).
import { computed, ref } from "vue";
import { listen } from "@tauri-apps/api/event";
import type { MeResponse } from "../../src/webapp/api-types";
import {
  api as backendApi, getConfig, getPaired, isConnectionError, logState, outdated, refreshLocale, setUnlockScan, type Config, type LogState,
} from "./backend";
import { connectionOf, gameDirOf, missingSetting, outdatedKeys, type Paired } from "./connection";
import { applyLangSetting, t } from "./i18n";
import { errorText, toastError } from "./toasts";

// Re-check interval while not connected
const RETRY_MS = 30_000;

export const config = ref<Config | null>(null);
// The connection the config asks for: the online server or the Quartermaster app on this PC
export const connection = computed(() => connectionOf(config.value));
// The local app as its pairing file last said (origin, its game folder); null online or while never seen
export const paired = ref<Paired | null>(null);
// The game folder in use: the paired app's in the local mode, else the config's own (undefined: no config yet)
export const gameDir = computed(() => (config.value ? gameDirOf(config.value, paired.value) : undefined));
// The server answered GET /api/me (online: server and token set and accepted; local: the app runs)
export const connected = ref(false);
// The user's name and avatar (online: Discord's, as of the login that created the token); null while unknown and
// for the local app's user, who has neither
export const meName = ref<string | null>(null);
export const meAvatar = ref<string | null>(null);
// The user's active orgs (the inventory scan offers to share registered stacks in them)
export const meOrgs = ref<MeResponse["orgs"]>([]);
// Why the connection is down (error code), null when connected or nothing checked yet
export const connectError = ref<unknown>(null);
// The followed Game.log and its unlocks
export const log = ref<LogState | null>(null);

/** The connection as one line ("Connection successful" or why not). */
export const connectionText = computed(() => {
  if (connected.value) return t("conn.ok");
  if (outdated.value) return t(outdatedKeys(outdated.value, connection.value).text);
  return connectError.value ? errorText(connectError.value) : t("conn.off");
});

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

/** Checks the connection with GET /api/me (online: server and token; local: the app found through its pairing file
 * and answering), also clearing an outdated state the server dropped. A new connection brings the game's English
 * texts up to date. */
export async function refreshConnection() {
  const missing = missingSetting(config.value);
  if (missing) {
    connected.value = false;
    meName.value = null;
    meAvatar.value = null;
    paired.value = null;
    connectError.value = missing;
    return;
  }
  const was = connected.value;
  try {
    const me = await api<MeResponse>("GET", "/me");
    // The Rust side read the pairing file for this call: its game folder is the one in use from here on
    paired.value = connection.value === "local" ? await getPaired() : null;
    meName.value = me.name;
    meAvatar.value = me.avatarUrl;
    meOrgs.value = me.orgs;
    connectError.value = null;
    outdated.value = null;
    connected.value = true;
    if (!was) void refreshLocale().catch((e) => console.warn("English texts:", e));
  } catch (e) {
    connected.value = false;
    connectError.value = e;
    // The app may have been found and still refuse (outdated), or be gone: its folder stays as last paired
    paired.value = connection.value === "local" ? await getPaired().catch(() => null) : null;
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

// The blueprints panel's filter "Unlocks": whether Game.log's unlocks are read (kept in localStorage; on
// by default; the Rust side starts on and gets the stored choice here)
const UNLOCKS_KEY = "qm.companion.unlocks";
export const unlocksOn = ref(localStorage.getItem(UNLOCKS_KEY) !== "0");

export async function toggleUnlocks() {
  unlocksOn.value = !unlocksOn.value;
  localStorage.setItem(UNLOCKS_KEY, unlocksOn.value ? "1" : "0");
  await setUnlockScan(unlocksOn.value).catch(toastError);
}

/** Follows the Rust side's log changes (new unlocks, Game.log found or gone). */
export async function watchLog() {
  await listen("log-changed", () => void loadLog());
  if (!unlocksOn.value) await setUnlockScan(false);
  await loadLog();
}
