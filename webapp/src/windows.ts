// The desktop shell's two windows (the main window and the settings window) show the same web app on the same origin. This is
// the one place where they know of each other: which window this page is (read once at start) and a BroadcastChannel over
// which the settings window tells the main window what happened. Safe where BroadcastChannel is missing (nothing is sent).
import { parseWindowMessage, WINDOW_CHANNEL, windowMode, type WindowMessage } from "./shellLogic";

/** This page is the settings window (the shell opens it at `/settings?window=settings`): the panel and a title bar only. */
export const settingsWindow = windowMode(window.location.search) === "settings";

function open(): BroadcastChannel | null {
  try {
    return typeof BroadcastChannel === "function" ? new BroadcastChannel(WINDOW_CHANNEL) : null;
  } catch {
    return null;
  }
}

let outgoing: BroadcastChannel | null | undefined;

/** Tells the other window (the settings window talks, the main window listens). */
export function post(message: WindowMessage): void {
  if (outgoing === undefined) outgoing = open();
  try {
    outgoing?.postMessage(message);
  } catch { /* the other window learns of it at its next poll */ }
}

/** A setting or the game data changed in the settings window: the main window reloads what it shows. Posts only from there. */
export function announceChange(): void {
  if (settingsWindow) post({ type: "changed" });
}

/** The main window listens; returns the function that stops. */
export function listen(handler: (message: WindowMessage) => void): () => void {
  const channel = open();
  if (!channel) return () => {};
  channel.onmessage = (event) => {
    const message = parseWindowMessage(event.data);
    if (message) handler(message);
  };
  return () => channel.close();
}
