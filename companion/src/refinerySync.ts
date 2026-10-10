// The refinery drafts in the app: the OCR's screens (Rust event "refinery-screen") go through the
// RefineryTracker (refinery.ts); a draft waits in the list until the user registers or drops it.
// Names are resolved against the web app's catalog in both languages (the game's is unknown).
import { listen } from "@tauri-apps/api/event";
import { ref, shallowRef } from "vue";
import type { CatalogResponse } from "../../src/webapp/api-types";
import { getDetect, getGameSeen, setDetect } from "./backend";
import { lang } from "./i18n";
import { buildCatalog, RefineryTracker, type Draft, type RefineryCatalog, type ScreenEvent } from "./refinery";
import { api, connected } from "./state";
import { toastError } from "./toasts";

const tracker = new RefineryTracker();
export const drafts = ref<Draft[]>([]);
// Detection on (on at every start; the state row's toggle switches it)
export const detecting = ref(true);
// Star Citizen runs (seen by the screen capture while detection is on)
export const gameSeen = ref(false);

export async function toggleDetect() {
  try {
    await setDetect(!detecting.value);
    detecting.value = await getDetect();
  } catch (e) {
    toastError(e);
  }
}
export const refineryCatalog = shallowRef<RefineryCatalog | null>(null);

/** The catalog lookups (again after a reconnect: the server's catalog may be newer). */
export async function loadRefineryCatalog() {
  if (!connected.value) return;
  try {
    const langs = lang === "de" ? ["de", "en"] : ["en", "de"];
    const responses: CatalogResponse[] = [];
    for (const l of langs) responses.push(await api<CatalogResponse>("GET", `/catalog?lang=${l}`));
    refineryCatalog.value = buildCatalog(responses);
  } catch (e) {
    toastError(e);
  }
}

export function dropDraft(id: string) {
  tracker.remove(id);
  drafts.value = [...tracker.drafts];
}

export async function watchRefinery() {
  detecting.value = await getDetect();
  gameSeen.value = await getGameSeen();
  await listen<boolean>("game-seen", (e) => {
    gameSeen.value = e.payload;
  });
  await listen<ScreenEvent>("refinery-screen", (e) => {
    if (tracker.feed(e.payload)) {
      drafts.value = [...tracker.drafts];
      if (!refineryCatalog.value) void loadRefineryCatalog();
    }
  });
}
