// Runs against TEST_DATABASE_URL only; the web, bot, app and catalog schemas there are dropped and recreated.
// Realtime end to end: the triggers of migration 0006, LISTEN, the hub and real WebSockets on a real server.
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, beforeEach, describe, it } from 'node:test';
import { sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import WebSocket from 'ws';
import { connect, type Db } from '../src/db/client.ts';
import { runImport } from '../src/catalog/import/apply.ts';
import { sha256, stableStringify } from '../src/catalog/import/plan.ts';
import { syncMember } from '../src/bot/roster.ts';
import { ensureGuild, updateGuildSettings, type GuildSettings } from '../src/bot/settings.ts';
import type { ServerMessage } from '../src/webapp/api-types.ts';
import { CLOSE_SESSION_ENDED, RealtimeHub, listenForChanges } from '../src/webapp/realtime.ts';
import { createSession, hashToken } from '../src/webapp/session.ts';
import { U, fixtureSnapshot } from './fixtures.ts';

const url = process.env.TEST_DATABASE_URL;
const ORIGIN = 'https://qm.test';
const [G, H] = ['700000000000000041', '700000000000000042'];
const MEMBER_ROLE = '710000000000000041';
const OFFICER_ROLE = '710000000000000042';
const [ME, MATE, STRANGER] = ['730000000000000041', '730000000000000042', '730000000000000043'];
const QUIET_MS = 250;

describe('realtime (database)', { skip: url ? false : 'TEST_DATABASE_URL not set' }, () => {
  let db: Db;
  let close: () => Promise<void>;
  let client: Awaited<ReturnType<typeof connect>>['client'];
  let server: Server;
  let hub: RealtimeHub;
  let port: number;
  let settings: GuildSettings;
  const sockets: WebSocket[] = [];

  const member = (userId: string, roleIds: string[], guildId = G) =>
    syncMember(db, guildId, settings, userId, { userId, displayName: `n${userId.slice(-2)}`, roleIds, bot: false });
  const session = (userId: string) => createSession(db, { id: userId, username: `u${userId.slice(-2)}`, globalName: null, avatar: null });
  const batch = (owner: string, guildId: string | null, quality: number) => db.execute(sql`
    INSERT INTO app.stock_batch (guild_id, owner_user_id, designation, kind, resource_uuid, location_uuid, quality, quantity)
    VALUES (${guildId}, ${owner}, ${guildId ? 'org' : 'personal'}, 'resource', ${U.metal}, ${U.station}, ${quality}, 1)`);

  /** An open socket that records what it receives. */
  async function socket(token: string) {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/ws`, { headers: { origin: ORIGIN, cookie: `__Host-qm_session=${token}` } });
    sockets.push(ws);
    const received: ServerMessage[] = [];
    ws.on('message', (data) => received.push(JSON.parse(data.toString()) as ServerMessage));
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('unexpected-response', (_req, res) => reject(new Error(`refused ${res.statusCode}`)));
    });
    let read = 0;
    return {
      ws,
      received,
      /** The next message not read yet, waiting up to a second for it. */
      async next(): Promise<ServerMessage> {
        for (let i = 0; i < 100 && received.length <= read; i++) await new Promise((r) => setTimeout(r, 10));
        assert.ok(received.length > read, 'no message');
        return received[read++]!;
      },
      /** Forgets what arrived so far. */
      skip() {
        read = received.length;
      },
    };
  }

  /** The HTTP status a handshake is refused with. */
  const refused = (headers: Record<string, string>, path = '/api/ws') => new Promise<number>((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`, { headers });
    ws.once('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0));
    ws.once('open', () => reject(new Error('handshake accepted')));
    ws.once('error', () => {});
  });
  const quiet = () => new Promise((r) => setTimeout(r, QUIET_MS));

  before(async () => {
    ({ db, close, client } = connect(url));
    for (const schema of ['web', 'bot', 'app', 'catalog', 'drizzle']) await db.execute(sql.raw(`DROP SCHEMA IF EXISTS ${schema} CASCADE`));
    await migrate(db, { migrationsFolder: new URL('../drizzle', import.meta.url).pathname });
    const snap = fixtureSnapshot();
    await runImport(db, snap, sha256(stableStringify(snap)), { dryRun: false, force: false, allowDowngrade: false, maxRetireRatio: 0.1, maxChangeRatio: 0.5 });
    for (const [id, name] of [[G, 'Org G'], [H, 'Org H']] as const) await ensureGuild(db, id, name);
    settings = await updateGuildSettings(db, G, { memberRoleIds: [MEMBER_ROLE], officerRoleIds: [OFFICER_ROLE] });
    await updateGuildSettings(db, H, { memberRoleIds: [MEMBER_ROLE], officerRoleIds: [OFFICER_ROLE] });
    await member(ME, [MEMBER_ROLE]);
    await member(MATE, [MEMBER_ROLE]);
    await member(STRANGER, [MEMBER_ROLE], H);

    hub = new RealtimeHub(db, { origin: ORIGIN, trustProxy: false, maxPerUser: 3, pingMs: 150 }, () => {});
    await listenForChanges(client, hub, () => {});
    server = createServer((_req, res) => res.end());
    server.on('upgrade', (req, sock, head) => hub.handleUpgrade(req, sock, head));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as AddressInfo).port;
  });
  beforeEach(() => {
    for (const ws of sockets.splice(0)) ws.terminate();
  });
  after(async () => {
    for (const ws of sockets) ws.terminate();
    hub?.close();
    await new Promise((r) => server?.close(r));
    await close?.();
  });

  it('refuses a wrong path, a foreign Origin, no session and an unknown session', async () => {
    const token = await session(ME);
    const cookie = `__Host-qm_session=${token}`;
    assert.equal(await refused({ origin: ORIGIN, cookie }, '/api/other'), 404);
    assert.equal(await refused({ origin: 'https://evil.test', cookie }), 403);
    assert.equal(await refused({ cookie }), 403);
    assert.equal(await refused({ origin: ORIGIN }), 401);
    assert.equal(await refused({ origin: ORIGIN, cookie: '__Host-qm_session=nope' }), 401);
  });

  it('limits the sockets per user', async () => {
    const token = await session(ME);
    for (let i = 0; i < 3; i++) await socket(token);
    assert.equal(await refused({ origin: ORIGIN, cookie: `__Host-qm_session=${token}` }), 429);
  });

  it('personal stock: only its owner hears about it', async () => {
    const me = await socket(await session(ME));
    const mate = await socket(await session(MATE));
    await batch(MATE, null, 501);
    await batch(ME, null, 502);
    assert.deepEqual(await me.next(), { type: 'stock', scope: 'personal' });
    assert.deepEqual(await mate.next(), { type: 'stock', scope: 'personal' });
    await quiet();
    assert.equal(me.received.length, 1);
    assert.equal(mate.received.length, 1);
  });

  it('org stock: the org members hear about it, nobody else', async () => {
    const me = await socket(await session(ME));
    const stranger = await socket(await session(STRANGER));
    await batch(ME, G, 503);
    assert.deepEqual(await me.next(), { type: 'stock', scope: 'org', guildId: G });
    await quiet();
    assert.equal(stranger.received.length, 0);
  });

  it('roster: the user reloads their orgs, the org reloads its member list; a joined org counts at once', async () => {
    const me = await socket(await session(ME));
    await member(ME, [OFFICER_ROLE]);
    const got = [await me.next(), await me.next()];
    assert.deepEqual(new Set(got.map((m) => JSON.stringify(m))), new Set([JSON.stringify({ type: 'me' }), JSON.stringify({ type: 'members', guildId: G })]));
    // Joining H: from then on H's stock reaches this socket
    await member(ME, [MEMBER_ROLE], H);
    await quiet();
    me.skip();
    await batch(STRANGER, H, 504);
    assert.deepEqual(await me.next(), { type: 'stock', scope: 'org', guildId: H });
  });

  it('org: freshness flips and bot presence are announced, the minute beat is not', async () => {
    const me = await socket(await session(ME));
    await db.execute(sql`UPDATE app.org SET roster_checked_at = now() WHERE guild_id = ${G}`);
    assert.deepEqual(await me.next(), { type: 'me' });
    await db.execute(sql`UPDATE app.org SET roster_checked_at = now() WHERE guild_id = ${G}`);
    await quiet();
    assert.equal(me.received.length, 1, 'beat announced');
    await db.execute(sql`UPDATE bot.guild SET left_at = now() WHERE guild_id = ${G}`);
    assert.deepEqual(await me.next(), { type: 'me' });
    await db.execute(sql`UPDATE bot.guild SET left_at = NULL WHERE guild_id = ${G}`);
  });

  it('blueprints and profile: the user and their org mates hear about it, others not', async () => {
    const me = await socket(await session(ME));
    const stranger = await socket(await session(STRANGER));
    await db.execute(sql`INSERT INTO app.user_blueprint (user_id, blueprint_uuid) VALUES (${MATE}, ${U.blueprint})`);
    assert.deepEqual(await me.next(), { type: 'blueprints', userId: MATE });
    await db.execute(sql`UPDATE app.app_user SET rsi_handle = 'mate' WHERE user_id = ${MATE}`);
    assert.deepEqual(await me.next(), { type: 'profile', userId: MATE });
    await quiet();
    assert.ok(!stranger.received.some((m) => m.type === 'blueprints' || m.type === 'profile'));
  });

  it('the web app language: the other tabs of that user reload, nobody else hears about it', async () => {
    const me = await socket(await session(ME));
    const mate = await socket(await session(MATE));
    await db.execute(sql`INSERT INTO web.user_setting (user_id, lang) VALUES (${ME}, 'de')`);
    assert.deepEqual(await me.next(), { type: 'me' });
    await quiet();
    assert.equal(mate.received.length, 0);
  });

  it('answers a ping, closes on anything else', async () => {
    const me = await socket(await session(ME));
    me.ws.send(JSON.stringify({ type: 'ping' }));
    assert.deepEqual(await me.next(), { type: 'pong' });
    const closed = new Promise<number>((r) => me.ws.once('close', (code) => r(code)));
    me.ws.send(JSON.stringify({ type: 'subscribe', to: 'everything' }));
    assert.equal(await closed, 1008);
  });

  it('closes the socket once its session is gone', async () => {
    const token = await session(ME);
    const me = await socket(token);
    const closed = new Promise<number>((r) => me.ws.once('close', (code) => r(code)));
    await db.execute(sql`DELETE FROM web.session WHERE token_hash = ${hashToken(token)}`);
    assert.equal(await closed, CLOSE_SESSION_ENDED);
  });
});
