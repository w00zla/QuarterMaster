// The app update's state for the main window (the Rust side: update.rs; the commands and the event are the desktop app's
// shell contract, webapp/src/shellLogic.ts). `update` is null until the Rust side answered; the update dialog
// (components/UpdateDialog.vue) opens from the footer and from the update panel.
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { ref } from "vue";
import { COMMANDS, UPDATE_EVENT, failedUpdate, parseUpdateState, type UpdateState } from "../../webapp/src/shellLogic.ts";

export const update = ref<UpdateState | null>(null);
export const updateOpen = ref(false);

const read = async () => parseUpdateState(await invoke(COMMANDS.updateState));

/** The state as it is now, then every change of it. */
export async function watchUpdate(): Promise<void> {
  await listen<unknown>(UPDATE_EVENT, (e) => {
    const next = parseUpdateState(e.payload);
    if (next) update.value = next;
  });
  update.value = await read();
}

export function openUpdate() {
  updateOpen.value = true;
  // The state as it is now, should an event have been missed
  void read().then((s) => s && (update.value = s), () => {});
}

export const closeUpdate = () => (updateOpen.value = false);

// A command the Rust side could not start shows as the updater's error, not as a silent nothing
async function run(command: string, args?: Record<string, unknown>) {
  try {
    await invoke(command, args);
  } catch (e) {
    if (update.value) update.value = failedUpdate(update.value, e);
  }
}

export const checkUpdate = () => run(COMMANDS.updateCheck);
export const installUpdate = () => run(COMMANDS.updateInstall);
export const setChannel = (id: string) => run(COMMANDS.updateSetChannel, { id });
