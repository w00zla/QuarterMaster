// The contract with the desktop shell (the Tauri app that runs the server and shows this SPA), as plain code: the command
// names and payloads the shell must provide, the update state, and what the dialog makes of it. No Vue and no DOM here, so the
// tests can drive it with a fake global (test/webapp-shell.test.ts); shell.ts wires it to the real `window.__TAURI__`.
//
// THE CONTRACT. The shell injects the global `window.__TAURI__` (Tauri's `withGlobalTauri`) into the page it loads from
// `http://127.0.0.1:<port>`; the SPA uses `__TAURI__.core.invoke(command, args)` and `__TAURI__.event.listen(event, handler)` and
// imports no Tauri package. Without the global, or without `core.invoke`, nothing is available (a browser).
//
// Commands (arguments as one object, the result is what `invoke` resolves with; a rejection is an error with a text):
//
//   pick_folder       {}                              -> string | null   the chosen folder, null when cancelled
//   pick_file         { extensions: string[] }        -> string | null   extensions without the dot (e.g. ["zip"]); [] = any file
//   open_external     { url: string }                 -> void            opens the URL in the system's default browser; the shell accepts
//                                                                        only absolute https:// URLs without credentials and rejects anything else
//   window_minimize   {}                              -> void
//   window_toggle_maximize {}                         -> void            maximize, or restore when maximized
//   window_close      {}                              -> void
//   window_is_maximized {}                            -> boolean
//   window_start_resize { direction: ResizeDirection } -> void           the window starts a resize drag from that edge or corner
//   open_settings     {}                              -> void            opens the settings window (label `settings`, the same origin at
//                                                                        `/settings?window=settings`), or brings it to the front
//   settings_window_fit { width, height }             -> void            the settings window's content size in CSS px, sent once after
//                                                                        its first render: the window gets that inner size and is shown
//   window_focus_main {}                              -> void            brings the main window to the front (from the settings window)
//   update_state      {}                              -> UpdateState
//   update_check      {}                              -> void            starts a check; the progress is `update-changed` events
//   update_install    {}                              -> void            starts the download and install of the available version
//   update_set_channel { id: string }                 -> void            saves the channel and checks it at once
//
// Dragging the window is not a command: the SPA marks the title bar with the standard `data-tauri-drag-region` attribute.
//
// Events: `update-changed`, payload `UpdateState` (every change of the state, progress included).
//
// The update commands exist only if the shell can update (a development build may lack them): when `update_state` rejects at
// start, the SPA treats the shell as one without app updates (no dialog, no mark, no button). The other commands are required.

/** What `update_state` and the `update-changed` event carry. */
export interface UpdateState {
  state: "idle" | "checking" | "current" | "available" | "downloading" | "installing" | "error";
  /** The running app's version, without a leading "v". */
  current: string;
  /** The version found, without a leading "v"; null until one is found. */
  available: string | null;
  /** The release notes of the available version (plain text); null when there are none. */
  notes: string | null;
  /** Download progress 0..1; null when not downloading or the size is not known. */
  progress: number | null;
  /** The error text shown as it is; null unless `state` is "error". */
  error: string | null;
  /** The selected channel's id. */
  channel: string;
  /** Every channel id the user can select (the selected one included). */
  channels: string[];
}

export type UpdatePhase = UpdateState["state"];
export type ResizeDirection = "North" | "South" | "East" | "West" | "NorthEast" | "NorthWest" | "SouthEast" | "SouthWest";

export const COMMANDS = {
  pickFolder: "pick_folder",
  pickFile: "pick_file",
  openExternal: "open_external",
  minimize: "window_minimize",
  toggleMaximize: "window_toggle_maximize",
  close: "window_close",
  isMaximized: "window_is_maximized",
  startResize: "window_start_resize",
  openSettings: "open_settings",
  fitSettings: "settings_window_fit",
  focusMain: "window_focus_main",
  updateState: "update_state",
  updateCheck: "update_check",
  updateInstall: "update_install",
  updateSetChannel: "update_set_channel",
} as const;
export const UPDATE_EVENT = "update-changed";

/** The part of Tauri's global the SPA uses. */
export interface TauriGlobal {
  core?: { invoke?: (command: string, args?: Record<string, unknown>) => Promise<unknown> };
  event?: { listen?: (event: string, handler: (event: { payload: unknown }) => void) => Promise<() => void> };
}

/** The shell's functions as the SPA calls them; the global is bound once. */
export interface ShellBinding {
  pickFolder(): Promise<string | null>;
  pickFile(extensions?: string[]): Promise<string | null>;
  openExternal(url: string): Promise<void>;
  minimize(): Promise<void>;
  toggleMaximize(): Promise<void>;
  close(): Promise<void>;
  isMaximized(): Promise<boolean>;
  startResize(direction: ResizeDirection): Promise<void>;
  openSettings(): Promise<void>;
  fitSettings(width: number, height: number): Promise<void>;
  focusMain(): Promise<void>;
  /** The state, or null when the shell has no updater (the command is missing or failed). */
  updateState(): Promise<UpdateState | null>;
  updateCheck(): Promise<void>;
  updateInstall(): Promise<void>;
  updateSetChannel(id: string): Promise<void>;
  /** Calls `handler` at every `update-changed`; resolves with the function that stops listening. */
  onUpdateChanged(handler: (state: UpdateState) => void): Promise<() => void>;
}

const PHASES: readonly string[] = ["idle", "checking", "current", "available", "downloading", "installing", "error"];

/** Reads a payload as an UpdateState; null when it is not one (a shell that does not keep the contract must not break the dialog). */
export function parseUpdateState(value: unknown): UpdateState | null {
  if (typeof value !== "object" || value === null) return null;
  const v = value as Record<string, unknown>;
  const text = (x: unknown): string | null => (typeof x === "string" ? x : null);
  if (typeof v.state !== "string" || !PHASES.includes(v.state)) return null;
  const channels = Array.isArray(v.channels) ? v.channels.filter((c): c is string => typeof c === "string") : [];
  return {
    state: v.state as UpdatePhase,
    current: text(v.current) ?? "",
    available: text(v.available),
    notes: text(v.notes),
    progress: typeof v.progress === "number" && Number.isFinite(v.progress) ? Math.min(1, Math.max(0, v.progress)) : null,
    error: text(v.error),
    channel: text(v.channel) ?? "",
    channels,
  };
}

/** Binds the global: null in a browser (no global, or no `core.invoke`). */
export function bindShell(tauri: TauriGlobal | undefined | null): ShellBinding | null {
  const invoke = tauri?.core?.invoke;
  if (typeof invoke !== "function") return null;
  const call = (command: string, args: Record<string, unknown> = {}) => invoke.call(tauri!.core, command, args);
  const path = async (command: string, args?: Record<string, unknown>) => {
    const result = await call(command, args);
    return typeof result === "string" && result !== "" ? result : null;
  };
  const done = async (command: string, args?: Record<string, unknown>) => void (await call(command, args));
  return {
    pickFolder: () => path(COMMANDS.pickFolder),
    pickFile: (extensions = []) => path(COMMANDS.pickFile, { extensions }),
    openExternal: (url) => done(COMMANDS.openExternal, { url }),
    minimize: () => done(COMMANDS.minimize),
    toggleMaximize: () => done(COMMANDS.toggleMaximize),
    close: () => done(COMMANDS.close),
    isMaximized: async () => (await call(COMMANDS.isMaximized)) === true,
    startResize: (direction) => done(COMMANDS.startResize, { direction }),
    openSettings: () => done(COMMANDS.openSettings),
    fitSettings: (width, height) => done(COMMANDS.fitSettings, { width, height }),
    focusMain: () => done(COMMANDS.focusMain),
    updateState: async () => {
      try {
        return parseUpdateState(await call(COMMANDS.updateState));
      } catch {
        return null;
      }
    },
    updateCheck: () => done(COMMANDS.updateCheck),
    updateInstall: () => done(COMMANDS.updateInstall),
    updateSetChannel: (id) => done(COMMANDS.updateSetChannel, { id }),
    onUpdateChanged: async (handler) => {
      const listen = tauri?.event?.listen;
      if (typeof listen !== "function") return () => {};
      return listen.call(tauri!.event, UPDATE_EVENT, (event) => {
        const state = parseUpdateState(event.payload);
        if (state) handler(state);
      });
    },
  };
}

// --- the settings window ---

/** Which window this page is: the shell opens the settings window at `/settings?window=settings` (read once at start). */
export type WindowMode = "main" | "settings";

export function windowMode(search: string): WindowMode {
  return new URLSearchParams(search).get("window") === "settings" ? "settings" : "main";
}

/** The settings window's width (CSS px): the panel (640) and the page's gutters; the dialogs it opens (560 wide at most) fit in it. */
export const SETTINGS_WIDTH = 672;
/** At least this high, so the dialogs (a dialog is about 230 px high and starts 10 % down) fit whatever the content is. */
export const SETTINGS_MIN_HEIGHT = 400;
/** A little more than measured: a fractional scale must not make the content a pixel too high for the window (a scroll bar). */
const SETTINGS_SLACK = 2;

/** The size to ask for from the measured content height: whole pixels, never below the minimum; null for a measurement that is no height. */
export function settingsFitSize(contentHeight: number): { width: number; height: number } | null {
  if (!Number.isFinite(contentHeight) || contentHeight <= 0) return null;
  return { width: SETTINGS_WIDTH, height: Math.max(SETTINGS_MIN_HEIGHT, Math.ceil(contentHeight) + SETTINGS_SLACK) };
}

/** What the two windows tell each other (same origin, one BroadcastChannel; windows.ts). */
export type WindowMessage = { type: "changed" } | { type: "open-update" };

export const WINDOW_CHANNEL = "quartermaster-windows";

/** Reads a message from the channel; null when it is none of ours. */
export function parseWindowMessage(value: unknown): WindowMessage | null {
  const type = typeof value === "object" && value !== null ? (value as { type?: unknown }).type : null;
  return type === "changed" || type === "open-update" ? { type } : null;
}

// --- links that leave the app ---

/** A click as the document's handler sees it: the link under it (null: not on a link) and the mouse button. */
export interface LinkClick {
  /** The link's resolved `href` (`a.href`, absolute); null or "" when the click is not on a link or the link has none. */
  href: string | null;
  /** The link's `target` attribute. */
  target: string | null;
  /** 0 = primary (also Enter on a focused link), 1 = middle; any other button is not ours. */
  button: number;
  /** Something else already handled the click. */
  defaultPrevented: boolean;
}

/**
 * Which click goes to the shell: with the shell present, a primary or middle click on a `target="_blank"` link with an absolute
 * https URL (the web app itself runs on http, so such a link always leaves it). Returns the URL for `open_external`, or null
 * when the browser's own behaviour stays (a browser has no shell; in-app links, blob: links, other schemes are not ours).
 */
export function externalLinkUrl(click: LinkClick, shellAvailable: boolean): string | null {
  if (!shellAvailable || click.defaultPrevented || (click.button !== 0 && click.button !== 1)) return null;
  if ((click.target ?? "").toLowerCase() !== "_blank" || !click.href) return null;
  let url: URL;
  try {
    url = new URL(click.href);
  } catch {
    return null;
  }
  return url.protocol === "https:" ? url.href : null;
}

// --- the update dialog ---

export type UpdateAction = "close" | "check" | "install";

export interface UpdateButton {
  action: UpdateAction;
  kind: "outline" | "primary";
  disabled: boolean;
  /** Close is parked at the far left of the footer. */
  left?: boolean;
}

/**
 * The footer's buttons for a state: Close always first; "Check Update" while nothing was found (idle, current, checking,
 * error), disabled while it checks; "Install" once a version is found (available, downloading, installing), disabled while it
 * downloads or installs.
 */
export function updateButtons(state: UpdatePhase): UpdateButton[] {
  const close: UpdateButton = { action: "close", kind: "outline", disabled: false, left: true };
  if (state === "available" || state === "downloading" || state === "installing") {
    return [close, { action: "install", kind: "primary", disabled: state !== "available" }];
  }
  return [close, { action: "check", kind: "outline", disabled: state === "checking" }];
}

/** A check, a download or an install is running: the channel cannot change. */
export const updateBusy = (state: UpdatePhase) => state === "checking" || state === "downloading" || state === "installing";

/** A version was found and waits to be (or is being) installed: the footer's mark. */
export const updateFound = (u: Pick<UpdateState, "state" | "available">) =>
  u.available !== null && (u.state === "available" || u.state === "downloading" || u.state === "installing");

export type StatusLine = { text: "update.checking" | "update.downloading" | "update.installing" | null; error: string | null; percent: number | null };

/** The one line under the notes: the busy text (text key), or the error as it is; the percent only while downloading. */
export function statusLine(u: Pick<UpdateState, "state" | "error" | "progress">): StatusLine {
  switch (u.state) {
    case "checking": return { text: "update.checking", error: null, percent: null };
    case "downloading": return { text: "update.downloading", error: null, percent: u.progress === null ? null : Math.round(u.progress * 100) };
    case "installing": return { text: "update.installing", error: null, percent: null };
    case "error": return { text: null, error: u.error ?? "", percent: null };
    default: return { text: null, error: null, percent: null };
  }
}

/** The state when a command itself failed (the shell could not even start it): shown like an error of the updater. */
export const failedUpdate = (u: UpdateState, error: unknown): UpdateState => ({
  ...u,
  state: "error",
  error: error instanceof Error ? error.message : typeof error === "string" ? error : String(error),
});
