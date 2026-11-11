// Who the user of a request is: the seam between the web app's HTTP layer and the variant it runs as.
// app.ts and realtime.ts know no login, session or token; they ask the Identity their composition root passes in:
// identity-discord.ts (online: Discord login, sessions, API tokens) or identity-local.ts (singleuser: one fixed
// user, no login). Design: docs/webapp.md "Identity".
import type { IncomingMessage } from 'node:http';
import type { Context, Hono } from 'hono';
import type { Env } from './routes.ts';

/** What the app hands the identity's HTTP parts: the things only createApp has. */
export interface IdentityHost {
  /** Where the browser sees the app (WebappConfig.origin). */
  origin: string;
  /** The request's client address, for the log. */
  clientIp(c: Context): string;
}

/** The user behind an accepted WebSocket. */
export interface SocketUser {
  userId: string;
  /** Asked at every keepalive: false once the login behind the socket has ended (the hub closes it). */
  valid(): Promise<boolean>;
}

export interface Identity {
  /**
   * CSRF: whether a write (any method but GET, HEAD, OPTIONS) may come in, judged by its browser headers.
   * Asked for every such request of the app, before anything else looks at it; false = 403.
   */
  acceptsWrite(c: Context, origin: string): boolean;
  /** Mounts the identity's own routes on the app (after its security headers, write check, no-store and the per-address rate limit of /auth/*). */
  mountRoutes(app: Hono<Env>, host: IdentityHost): void;
  /**
   * Whether an API request is the companion app's (not the web app's own): the app then holds it to the companion
   * API contract (companionApiRefusal), before `authenticate` looks at it.
   */
  isCompanionRequest(c: Context): boolean;
  /**
   * The user of an API request: sets `session` (and `apiToken` for a request that is not the web app's own) on
   * the context and returns nothing, or returns the refusal to send. Runs before any API route, unknown ones too.
   */
  authenticate(c: Context<Env>, host: IdentityHost): Promise<Response | undefined>;
  /** Mounts the API routes that only exist with accounts (behind authenticate and the API's own checks). */
  mountApiRoutes(api: Hono<Env>, host: IdentityHost): void;
  /** The user of a WebSocket handshake (path, Origin and the address limit are checked by the hub before); null = 401. */
  authenticateUpgrade(req: IncomingMessage): Promise<SocketUser | null>;
}

/** The same-origin rule for a write: `Sec-Fetch-Site` where the browser sends it, else `Origin` must be ours. */
export function sameOrigin(c: Context, origin: string): boolean {
  const site = c.req.header('sec-fetch-site');
  return site !== undefined ? site === 'same-origin' : c.req.header('origin') === origin;
}
