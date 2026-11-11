// The desktop shell's native functions, behind one small adapter: the rest of the app asks here and never imports the
// shell itself. In a browser nothing is available (`available` is false, the pickers answer null, no window chrome, no app
// update). In the desktop shell (the Tauri app) `initShell()` binds the global it injects; the commands, payloads and events
// the shell must provide are listed in shellLogic.ts and docs/webapp.md "The desktop shell".

import { reactive } from "vue";
import { bindShell, failedUpdate, type ResizeDirection, type ShellBinding, type TauriGlobal, type UpdateState } from "./shellLogic";

export interface Shell {
  /** The desktop shell is there: native pickers and the frameless window chrome are rendered only then. */
  available: boolean;
  /** Opens the folder picker; the chosen folder, or null when cancelled (or unavailable). */
  pickFolder(): Promise<string | null>;
  /** Opens the file picker (`extensions`: without the dot, e.g. "zip"); the chosen file, or null. */
  pickFile(extensions?: string[]): Promise<string | null>;
  /** The shell offers app updates (the version button, the mark, the dialog and the bold notice's button are rendered only then). */
  updateAvailable: boolean;
  /** Opens the app update dialog. */
  openUpdate(): void;
  /** Whether the app update dialog is open (App.vue renders it). */
  updateOpen: boolean;
  closeUpdate(): void;
  /** The updater's state; null until the shell has answered (and always without updates). */
  update: UpdateState | null;
  checkUpdate(): Promise<void>;
  installUpdate(): Promise<void>;
  setChannel(id: string): Promise<void>;
  /** The window is maximized (the restore icon); follows the window's size. */
  maximized: boolean;
  minimize(): void;
  toggleMaximize(): void;
  close(): void;
  startResize(direction: ResizeDirection): void;
}

// Reactive: the shell sets its functions once it is up, and the buttons that depend on them appear
export const shell: Shell = reactive<Shell>({
  available: false,
  pickFolder: () => Promise.resolve(null),
  pickFile: () => Promise.resolve(null),
  updateAvailable: false,
  openUpdate: () => {},
  updateOpen: false,
  closeUpdate: () => {},
  update: null,
  checkUpdate: () => Promise.resolve(),
  installUpdate: () => Promise.resolve(),
  setChannel: () => Promise.resolve(),
  maximized: false,
  minimize: () => {},
  toggleMaximize: () => {},
  close: () => {},
  startResize: () => {},
});

/** Binds the shell's global (default `window.__TAURI__`). Without it nothing changes: everything stays "not available". */
export async function initShell(tauri: TauriGlobal | undefined = (window as { __TAURI__?: TauriGlobal }).__TAURI__): Promise<void> {
  const bound = bindShell(tauri);
  if (!bound) return;
  wire(bound);
  // The window's size follows the user: the maximize state is asked again at every resize (and after a toggle)
  const refreshMaximized = () => void bound.isMaximized().then((m) => (shell.maximized = m), () => {});
  window.addEventListener("resize", refreshMaximized);
  refreshMaximized();
  shell.available = true;
  // The updater is optional: a shell without it answers nothing here
  const state = await bound.updateState();
  if (!state) return;
  shell.update = state;
  shell.updateAvailable = true;
  await bound.onUpdateChanged((next) => (shell.update = next));
}

function wire(bound: ShellBinding): void {
  const quiet = (p: Promise<unknown>) => void p.catch((e) => console.error("shell command failed", e));
  shell.pickFolder = () => bound.pickFolder().catch(() => null);
  shell.pickFile = (extensions) => bound.pickFile(extensions).catch(() => null);
  shell.openUpdate = () => {
    shell.updateOpen = true;
    // The state as it is now, should an event have been missed
    void bound.updateState().then((s) => s && (shell.update = s));
  };
  shell.closeUpdate = () => (shell.updateOpen = false);
  // A command the shell could not start shows as the updater's error, not as a silent nothing
  const run = async (command: () => Promise<void>) => {
    try {
      await command();
    } catch (e) {
      if (shell.update) shell.update = failedUpdate(shell.update, e);
    }
  };
  shell.checkUpdate = () => run(bound.updateCheck);
  shell.installUpdate = () => run(bound.updateInstall);
  shell.setChannel = (id) => run(() => bound.updateSetChannel(id));
  shell.minimize = () => quiet(bound.minimize());
  shell.toggleMaximize = () => quiet(bound.toggleMaximize().then(() => bound.isMaximized()).then((m) => (shell.maximized = m)));
  shell.close = () => quiet(bound.close());
  shell.startResize = (direction) => quiet(bound.startResize(direction));
}
