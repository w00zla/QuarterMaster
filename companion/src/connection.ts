// Which server the companion talks to and what its refusals lead to (pure: tested from the root
// test/companion-connection.test.ts). Two connections: "online" (the web app's server with the user's Access Key)
// and "local" (the Quartermaster app on this PC, found by the Rust side through its pairing file: no key, and its
// game folder comes first).
import type { CompanionOutdated, ServerOutdated } from "../../src/webapp/api-types.ts";

export type Connection = "online" | "local";

/** The connection a config asks for; anything but "local" (older config files have none) is online. */
export const connectionOf = (config: { connection?: string } | null | undefined): Connection =>
  config?.connection === "local" ? "local" : "online";

/** What a config lacks to connect at all, as the connection's error code; null = it can be tried. The local
 * connection needs nothing from the config (the pairing file is read per attempt). */
export function missingSetting(config: { connection?: string; server: string; token: string } | null): "noServer" | "noToken" | null {
  if (connectionOf(config) === "local") return null;
  if (!config?.server) return "noServer";
  return config.token ? null : "noToken";
}

/** Whether saving `next` makes the companion talk to another server than `saved`: another connection, or online
 * another server address (both as stored: trimmed, the production server written out). The app never switches
 * servers while it runs: such a save restarts it (Rust `set_config` with `config::other_server`, the same rule). */
export function otherServer(saved: { connection?: string; server: string } | null, next: { connection?: string; server: string }): boolean {
  const to = connectionOf(next);
  if (connectionOf(saved) !== to) return true;
  return to === "online" && next.server.trim() !== (saved?.server ?? "").trim();
}

/** The local app as its pairing file last said (Rust `paired`). */
export interface Paired {
  origin: string;
  // The app's game folder setting, null = not set there
  gameDir: string | null;
}

/** The game folder in use: the paired app's in the local mode when it has one, else the companion's own setting. */
export function gameDirOf(config: { connection?: string; gameDir: string }, paired: Paired | null): string {
  return connectionOf(config) === "local" && paired?.gameDir ? paired.gameDir : config.gameDir;
}

// The API contract check's refusal: which side is too old (the app does no work until that changed)
export type Outdated = { side: "companion"; apiMin: number } | { side: "server"; apiMax: number };

/** The contract refusal in an API answer, null for any other answer: 426 = this companion is older than the server
 * accepts, 409 `serverOutdated` = the server (or the local app) is older than this companion. Other 409s are
 * ordinary refusals of a route. */
export function outdatedOf(status: number, body: unknown): Outdated | null {
  // CompanionOutdated (426) or ServerOutdated (409), read loosely: the body is the server's
  const b = (body ?? {}) as { error?: ServerOutdated["error"] | CompanionOutdated["error"]; apiMin?: unknown; apiMax?: unknown };
  if (status === 426) return { side: "companion", apiMin: typeof b.apiMin === "number" ? b.apiMin : 0 };
  if (status === 409 && b.error === "serverOutdated") return { side: "server", apiMax: typeof b.apiMax === "number" ? b.apiMax : 0 };
  return null;
}

/** The error code an API answer throws, null for a good one: the contract refusals by their side, else the body's
 * `error`, else the status. */
export function refusalOf(status: number, body: unknown): string | null {
  const outdated = outdatedOf(status, body);
  if (outdated) return outdated.side === "companion" ? "companionOutdated" : "serverOutdated";
  if (status < 400) return null;
  return (body as { error?: string } | null)?.error ?? `HTTP ${status}`;
}

// Codes that mean the connection itself is refused (shown as the connection state, not as a toast)
const CONNECTION_CODES = new Set([
  "noServer", "noToken", "invalidServer", "insecureServer", "invalidToken", "network", "noLocalApp", "companionOutdated", "serverOutdated",
]);
export const isConnectionCode = (code: string) => CONNECTION_CODES.has(code);

/** The text keys for an outdated side, the short state (`title`: the panel's head, the top bar's chip) and its
 * sentence (`text`): the server's wording depends on which server it is. */
export function outdatedKeys(outdated: Outdated, connection: Connection) {
  if (outdated.side === "companion") return { title: "outdated.title", text: "err.companionOutdated" } as const;
  return connection === "local"
    ? { title: "outdated.title.app", text: "err.appOutdated" } as const
    : { title: "outdated.title.server", text: "err.serverOutdated" } as const;
}
