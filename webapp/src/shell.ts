// The desktop shell's native functions, behind one small adapter: the rest of the app asks here and never imports the
// shell itself. In a browser nothing is available (`available` is false, the pickers answer null, no app update);
// the desktop shell fills the three functions in.

import { reactive } from "vue";

export interface Shell {
  /** A native folder / file picker exists: the buttons that open one are rendered only then. */
  available: boolean;
  /** Opens the folder picker; the chosen folder, or null when cancelled (or unavailable). */
  pickFolder(): Promise<string | null>;
  /** Opens the file picker (`extensions`: without the dot, e.g. "zip"); the chosen file, or null. */
  pickFile(extensions?: string[]): Promise<string | null>;
  /** The shell offers app updates (the bold notice's button and the version's update entry are rendered only then). */
  updateAvailable: boolean;
  /** Opens the app update. */
  openUpdate(): void;
}

// Reactive: the shell sets its functions once it is up, and the buttons that depend on them appear
export const shell: Shell = reactive<Shell>({
  available: false,
  pickFolder: () => Promise.resolve(null),
  pickFile: () => Promise.resolve(null),
  updateAvailable: false,
  openUpdate: () => {},
});
