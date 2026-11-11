// The pure side of the app update (the Rust side is update.rs; the state, its buttons and its status line are the web app's
// shellLogic.ts, the desktop app's contract): the error code of an installation that cannot update itself, and what the
// update panel's button does. No Vue, no Tauri here, so the tests can run it (test/companion-update.test.ts).
import { updateFound, type UpdateState } from "../../webapp/src/shellLogic.ts";

/** The `error` the Rust side gives for an installation that cannot update itself, followed by the version (update.rs `CANNOT_UPDATE`). */
export const CANNOT_UPDATE = "cannot-update:";

/** The version of a "cannot update itself" error; null for any other error text. */
export function cannotUpdateVersion(error: string | null): string | null {
  return error !== null && error.startsWith(CANNOT_UPDATE) ? error.slice(CANNOT_UPDATE.length) : null;
}

/** What the update panel's button for an outdated companion does: opens the update dialog while the updater has a version, else the releases page. */
export function outdatedButtonOpens(update: Pick<UpdateState, "state" | "available"> | null): "dialog" | "releases" {
  return update && updateFound(update) ? "dialog" : "releases";
}
