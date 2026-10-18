// The scan session (Rust: ocrwatch.rs): the user starts it for one terminal kind from that panel's
// head and stops it there; one session at a time (starting another stops the running one). While a
// session runs, the screen capture tells whether the game runs (event "game-seen"). Off at every start.
import { listen } from "@tauri-apps/api/event";
import { ref } from "vue";
import { getGameSeen, getScan, setScan, type ScanMode } from "./backend";
import { toastError } from "./toasts";

export const scanMode = ref<ScanMode>("off");
// Star Citizen runs (seen by the screen capture while a session runs)
export const gameSeen = ref(false);

/** Starts a session (or stops it with "off"); the running one ends. */
export async function startScan(mode: ScanMode) {
  try {
    await setScan(mode);
    scanMode.value = await getScan();
  } catch (e) {
    toastError(e);
  }
}

export const stopScan = () => startScan("off");

export async function watchScan() {
  scanMode.value = await getScan();
  gameSeen.value = await getGameSeen();
  await listen<boolean>("game-seen", (e) => {
    gameSeen.value = e.payload;
  });
}
