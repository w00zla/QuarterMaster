// Realtime for the user web app: one LISTEN connection to Postgres (channel qm_changes, filled by the
// triggers of migration 0006 whoever writes) fans out to the browsers' WebSockets (/api/ws). Messages
// only say what changed (ServerMessage); the data comes through the normal endpoints, which check
// the rights. The handshake runs outside Hono (Node's 'upgrade' event), so it checks everything
// itself: path, Origin (cross-site WebSocket hijacking), connection limits, session.
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { sql } from 'drizzle-orm';
import { parse as parseCookies } from 'hono/utils/cookie';
import type postgres from 'postgres';
import { WebSocketServer, type RawData, type WebSocket } from 'ws';
import { z } from 'zod';
import type { Db } from '../db/client.ts';
import type { ServerMessage } from './api-types.ts';
import { clientAddress, rateKey } from './ip.ts';
import { SESSION_COOKIE, validateSession } from './session.ts';

export const CHANNEL = 'qm_changes';
const SESSION_COOKIE_NAME = `__Host-${SESSION_COOKIE}`;
// Closing codes the SPA knows: the session is gone (log in again)
export const CLOSE_SESSION_ENDED = 4401;

const changeSchema = z.object({
  t: z.string(), g: z.string().nullable(), u: z.string().nullable(),
  // History rows (0012): id, source, actor, new owner; the action since 0019
  id: z.number().int().optional(), s: z.enum(['bot', 'webapp', 'companion']).optional(), a: z.string().optional(), o: z.string().nullable().optional(),
  x: z.string().optional(),
});
export type Change = z.infer<typeof changeSchema>;
const clientMessageSchema = z.object({ type: z.literal('ping') }).strict();

type Log = (message: string, err?: unknown) => void;

export interface RealtimeOptions {
  // Same as the app: the only Origin a handshake may come from
  origin: string;
  trustProxy: boolean;
  maxPerUser?: number;
  maxPerAddress?: number;
  // Keepalive: ping, drop dead connections, check the session again
  pingMs?: number;
}

interface Conn {
  ws: WebSocket;
  userId: string;
  token: string;
  address: string;
  // Active memberships, refreshed when the roster changes for this user
  orgs: Set<string>;
  alive: boolean;
  recent: number[];
}

const MAX_MESSAGE_BYTES = 4096;
const MESSAGE_WINDOW_MS = 10_000;
const MAX_MESSAGES = 20;

export class RealtimeHub {
  private readonly db: Db;
  private readonly options: Required<RealtimeOptions>;
  private readonly log: Log;
  private readonly conns = new Set<Conn>();
  private readonly wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES });
  private readonly timer: ReturnType<typeof setInterval>;

  constructor(db: Db, options: RealtimeOptions, log: Log) {
    this.db = db;
    this.options = { maxPerUser: 5, maxPerAddress: 20, pingMs: 25_000, ...options };
    this.log = log;
    this.timer = setInterval(() => void this.keepalive(), this.options.pingMs);
    this.timer.unref();
  }

  /** Node's 'upgrade' event of the HTTP server. */
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer) {
    const reject = (status: number, text: string) => {
      socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    };
    socket.on('error', () => socket.destroy());
    if (new URL(req.url ?? '/', 'http://localhost').pathname !== '/api/ws') return reject(404, 'Not Found');
    // Browsers send cookies with a cross-site handshake and CORS does not apply: Origin decides
    if (req.headers.origin !== this.options.origin) return reject(403, 'Forbidden');
    const forwarded = req.headers['x-forwarded-for'];
    const address = rateKey(clientAddress(Array.isArray(forwarded) ? forwarded.at(-1) : forwarded,
      req.socket.remoteAddress, this.options.trustProxy));
    if (this.count((c) => c.address === address) >= this.options.maxPerAddress) return reject(429, 'Too Many Requests');
    const token = parseCookies(req.headers.cookie ?? '', SESSION_COOKIE_NAME)[SESSION_COOKIE_NAME];
    if (!token) return reject(401, 'Unauthorized');
    validateSession(this.db, token).then(async (session) => {
      if (!session) return reject(401, 'Unauthorized');
      if (this.count((c) => c.userId === session.userId) >= this.options.maxPerUser) return reject(429, 'Too Many Requests');
      const orgs = await this.orgsOf(session.userId);
      this.wss.handleUpgrade(req, socket, head, (ws) => this.register(ws, session.userId, token, address, orgs));
    }).catch((err: unknown) => {
      this.log('Realtime handshake failed', err);
      reject(500, 'Internal Server Error');
    });
  }

  /** A change announced by the database. */
  async dispatch(change: Change) {
    const { t, g, u } = change;
    switch (t) {
      case 'member':
        // The user's own memberships first: later events depend on them
        if (u) await this.refreshOrgs(u);
        this.send((c) => c.userId === u, { type: 'me' });
        if (g) this.send((c) => c.orgs.has(g), { type: 'members', guildId: g });
        break;
      case 'org':
        if (g) this.send((c) => c.orgs.has(g), { type: 'me' });
        break;
      case 'stock':
        if (g) this.send((c) => c.orgs.has(g), { type: 'stock', scope: 'org', guildId: g });
        else if (u) this.send((c) => c.userId === u, { type: 'stock', scope: 'personal' });
        break;
      case 'setting':
        // The web app's own settings (language): the user's other tabs
        if (u) this.send((c) => c.userId === u, { type: 'me' });
        break;
      case 'history': {
        // To the users it concerns: who did it, whose data, the new owner; stock shared in an org also
        // to that org's members
        if (change.id === undefined || !change.s || !change.a) break;
        const users = new Set([change.a, u, change.o].filter((x): x is string => Boolean(x)));
        const org = change.x === 'share' ? g : null;
        this.send((c) => users.has(c.userId) || (!!org && c.orgs.has(org)), { type: 'history', id: change.id, source: change.s, actor: change.a });
        break;
      }
      case 'blueprint':
      case 'user': {
        if (!u) break;
        // The own profile is part of /api/me
        if (t === 'user') this.send((c) => c.userId === u, { type: 'me' });
        // Visible to the user and to everyone sharing an org with them
        const orgs = await this.orgsOf(u);
        const message: ServerMessage = t === 'blueprint' ? { type: 'blueprints', userId: u } : { type: 'profile', userId: u };
        this.send((c) => c.userId === u || [...c.orgs].some((o) => orgs.has(o)), message);
        break;
      }
    }
  }

  /** Changes may have been missed: every client reloads. */
  resync() {
    this.send(() => true, { type: 'resync' });
  }

  close() {
    clearInterval(this.timer);
    for (const c of this.conns) c.ws.terminate();
    this.conns.clear();
    this.wss.close();
  }

  private register(ws: WebSocket, userId: string, token: string, address: string, orgs: Set<string>) {
    const conn: Conn = { ws, userId, token, address, orgs, alive: true, recent: [] };
    this.conns.add(conn);
    ws.on('pong', () => (conn.alive = true));
    ws.on('message', (data, isBinary) => this.receive(conn, data, isBinary));
    ws.on('close', () => this.conns.delete(conn));
    ws.on('error', () => ws.terminate());
  }

  private receive(conn: Conn, data: RawData, isBinary: boolean) {
    const now = Date.now();
    conn.recent = conn.recent.filter((at) => now - at < MESSAGE_WINDOW_MS);
    conn.recent.push(now);
    if (conn.recent.length > MAX_MESSAGES) return conn.ws.close(1008, 'too many messages');
    if (isBinary) return conn.ws.close(1003, 'text only');
    let message: unknown;
    try {
      message = JSON.parse(data.toString());
    } catch {
      return conn.ws.close(1008, 'invalid message');
    }
    const parsed = clientMessageSchema.safeParse(message);
    if (!parsed.success) return conn.ws.close(1008, 'invalid message');
    this.sendTo(conn, { type: 'pong' });
  }

  private async keepalive() {
    for (const conn of [...this.conns]) {
      if (!conn.alive) {
        conn.ws.terminate();
        continue;
      }
      conn.alive = false;
      conn.ws.ping();
      // Logout, expiry or a new login elsewhere ended the session: the socket goes too
      const session = await validateSession(this.db, conn.token).catch(() => undefined);
      if (session === null) conn.ws.close(CLOSE_SESSION_ENDED, 'session ended');
    }
  }

  private async refreshOrgs(userId: string) {
    const mine = [...this.conns].filter((c) => c.userId === userId);
    if (!mine.length) return;
    const orgs = await this.orgsOf(userId);
    for (const c of mine) c.orgs = orgs;
  }

  private async orgsOf(userId: string): Promise<Set<string>> {
    const rows = await this.db.execute<{ guild_id: string }>(
      sql`SELECT guild_id FROM app.member WHERE user_id = ${userId} AND active`);
    return new Set(rows.map((r) => r.guild_id));
  }

  private count(match: (c: Conn) => boolean) {
    let n = 0;
    for (const c of this.conns) if (match(c)) n++;
    return n;
  }

  private send(match: (c: Conn) => boolean, message: ServerMessage) {
    for (const c of this.conns) if (match(c)) this.sendTo(c, message);
  }

  private sendTo(conn: Conn, message: ServerMessage) {
    if (conn.ws.readyState === conn.ws.OPEN) conn.ws.send(JSON.stringify(message));
  }
}

/** Feeds the database's change announcements into the hub; after a reconnect of the listener, a resync. */
export async function listenForChanges(client: postgres.Sql, hub: RealtimeHub, log: Log) {
  let connected = false;
  // One after another, in the order the database announced them
  let queue = Promise.resolve();
  return client.listen(CHANNEL, (payload) => {
    let change: Change;
    try {
      change = changeSchema.parse(JSON.parse(payload));
    } catch (err) {
      log(`Unexpected change payload: ${payload}`, err);
      return;
    }
    queue = queue.then(() => hub.dispatch(change)).catch((err: unknown) => log('Realtime dispatch failed', err));
  }, () => {
    // Called on every (re)connect: what happened in between was not heard
    if (connected) hub.resync();
    connected = true;
  });
}
