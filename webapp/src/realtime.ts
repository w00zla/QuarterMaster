// Live updates: a WebSocket to /api/ws on which the server says what changed (ServerMessage); the
// app then fetches it through the normal endpoints. Reconnects with backoff while logged in, and
// reloads after a reconnect (what changed in between was not heard).
import type { ServerMessage } from "../../src/webapp/api-types";
import { loadMe, status } from "./session";

// The server closes with this when the session is gone (src/webapp/realtime.ts)
const CLOSE_SESSION_ENDED = 4401;
const MAX_DELAY_MS = 30_000;

type Handler = (message: ServerMessage) => void;
const handlers = new Set<Handler>();

/** For views that show more than /api/me (stock, blueprints): returns the unsubscribe. */
export function onServerMessage(handler: Handler): () => void {
  handlers.add(handler);
  return () => handlers.delete(handler);
}

/**
 * A reload for bursts of messages ("Register all" in the companion app sends one per blueprint):
 * `schedule` runs `fn` once, `quietMs` after the last call and at most `maxWaitMs` after the first;
 * `cancel` drops a pending run (when the view goes).
 */
export function coalesced(fn: () => void, quietMs = 300, maxWaitMs = 3000) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let firstAt = 0;
  const run = () => {
    firstAt = 0;
    fn();
  };
  return {
    schedule() {
      const now = Date.now();
      if (!firstAt) firstAt = now;
      clearTimeout(timer);
      timer = setTimeout(run, Math.max(0, Math.min(quietMs, firstAt + maxWaitMs - now)));
    },
    cancel() {
      clearTimeout(timer);
      firstAt = 0;
    },
  };
}

let socket: WebSocket | null = null;
let attempts = 0;
let retryTimer: ReturnType<typeof setTimeout> | undefined;

export function startRealtime() {
  if (!socket) open();
}

export function stopRealtime() {
  clearTimeout(retryTimer);
  const current = socket;
  socket = null;
  current?.close(1000);
}

function open() {
  const ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/api/ws`);
  socket = ws;
  ws.onopen = () => {
    // Not the first connect: whatever changed meanwhile was missed
    if (attempts > 0) void loadMe();
    attempts = 0;
  };
  ws.onmessage = (event) => {
    let message: ServerMessage;
    try {
      message = JSON.parse(String(event.data)) as ServerMessage;
    } catch {
      return;
    }
    if (message.type === "me" || message.type === "resync") void loadMe();
    for (const handler of handlers) handler(message);
  };
  ws.onclose = (event) => {
    if (socket !== ws) return; // stopped on purpose
    socket = null;
    // Session gone: /api/me answers 401 and the login screen shows
    if (event.code === CLOSE_SESSION_ENDED) void loadMe();
    const delay = Math.min(MAX_DELAY_MS, 1000 * 2 ** attempts++);
    retryTimer = setTimeout(() => {
      if (status.value === "in" && !socket) open();
    }, delay);
  };
}
