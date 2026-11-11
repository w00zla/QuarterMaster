// Which state the start tile shows, from what the data update endpoint said (pure: tested in test/webapp-local.test.ts).
// The tile replaces the app while the singleuser variant has no game data installed.
import type { DataUpdateState } from "../../src/webapp/api-types.ts";

/** The step texts (text keys; the tile checks them against the texts). */
export type StepText = "start.starting" | "start.setup" | "start.loading";

/** Failed state requests in a row (while nothing says an install is running) before the tile says the server is gone. */
export const UNREACHABLE_AFTER = 5;

export type TileModel =
  | { visible: false }
  // Progress: `step` of `segments` segments filled, one line of text; `progress` only while a download reports its size
  | { visible: true; view: "steps"; step: number; segments: number; text: StepText; progress: { done: number; total: number } | null }
  // Nothing installed and nothing to fetch it with: no connection or a failed run (tag + text, import and retry)
  | { visible: true; view: "offline" }
  // Nothing installed, no update running and none planned (updates off, no channel)
  | { visible: true; view: "missing" }
  // The newest data needs a newer app: the notice instead of the tag
  | { visible: true; view: "tooOld" }
  | { visible: true; view: "unreachable" };

export const SEGMENTS = 4;

const steps = (step: number, text: StepText, progress: { done: number; total: number } | null = null): TileModel => ({
  visible: true,
  view: "steps",
  step,
  segments: SEGMENTS,
  text,
  progress,
});

export interface TileInput {
  /** The last state that came in (null = none yet). */
  data: DataUpdateState | null;
  /** State requests that failed or timed out since that one. */
  failedPolls: number;
  /** The settings' automatic updates (null = not known yet): off means nothing starts a check by itself. */
  autoUpdate: boolean | null;
}

/**
 * The tile for the last state. It shows only while no data pack is installed; once one is, the app takes over.
 * A state request that fails or times out while the last state was a download or an installation counts as "still
 * installing" (the catalog import blocks the whole server for a few seconds), never as an error.
 */
export function tileModel({ data, failedPolls, autoUpdate }: TileInput): TileModel {
  if (data?.installed) return { visible: false };
  if (!data) return failedPolls >= UNREACHABLE_AFTER ? { visible: true, view: "unreachable" } : steps(1, "start.starting");
  // A check can turn into a download and an installation between two requests: any busy phase counts
  if (data.phase === "installing" || (failedPolls > 0 && data.phase !== "idle")) return steps(3, "start.setup");
  if (data.phase === "downloading") return steps(2, "start.loading", data.progress);
  if (data.phase === "checking") return steps(2, "start.loading");
  // Idle from here
  if (failedPolls >= UNREACHABLE_AFTER) return { visible: true, view: "unreachable" };
  const last = data.last;
  if (!last) return autoUpdate === false ? { visible: true, view: "missing" } : steps(1, "start.starting");
  if (last.outcome === "offline" || last.outcome === "failed") return { visible: true, view: "offline" };
  if (last.outcome === "appTooOld") return { visible: true, view: "tooOld" };
  // installed: the next state shows the pack; noChannel / upToDate with nothing installed: there is nothing to fetch
  return last.outcome === "installed" ? steps(3, "start.setup") : { visible: true, view: "missing" };
}

/** The share of the download that came in, 0 to 1 (0 without a size). */
export function progressShare(p: { done: number; total: number } | null): number {
  return p && p.total > 0 ? Math.min(1, Math.max(0, p.done / p.total)) : 0;
}
