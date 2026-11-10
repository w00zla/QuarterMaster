// Runs against TEST_DATABASE_URL only; the web, bot, app and catalog schemas there are dropped and recreated.
// The web app as the singleuser variant builds it: the local identity (one fixed user, no login), orgs off.
// Through Hono (app.request) and, for the WebSocket, a real server.
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import { sql } from 'drizzle-orm';
import WebSocket from 'ws';
import type { Db } from '../src/db/client.ts';
import { connectAs, prepareDb } from './roles.ts';
import { runImport } from '../src/catalog/import/apply.ts';
import { sha256, stableStringify } from '../src/catalog/import/plan.ts';
import { syncMember } from '../src/bot/roster.ts';
import { ensureGuild, updateGuildSettings } from '../src/bot/settings.ts';
import type { Capabilities, MeResponse, ServerMessage, StockListResponse } from '../src/webapp/api-types.ts';
import { createApp, type WebappConfig } from '../src/webapp/app.ts';
import type { Identity } from '../src/webapp/identity.ts';
import { LOCAL_USER_ID, localIdentity } from '../src/webapp/identity-local.ts';
import { RealtimeHub, listenForChanges } from '../src/webapp/realtime.ts';
import { U, fixtureSnapshot } from './fixtures.ts';

const url = process.env.TEST_DATABASE_URL;
const ORIGIN = 'http://127.0.0.1:3002';
const CAPS: Capabilities = { login: 'none', orgs: false, uex: false };
// An org with a member, as an imported database could hold: the local user is none of it
const G = '700000000000000071';
const MEMBER_ROLE = '710000000000000071';
const OTHER = '740000000000000071';
const JSON_TYPE = { 'content-type': 'application/json' };

describe('web app, local identity (database)', { skip: url ? false : 'TEST_DATABASE_URL not set' }, () => {
  let db: Db;
  let webDb: Db;
  let closeDb: () => Promise<void>;
  let closeWeb: () => Promise<void>;
  let client: ReturnType<typeof connectAs>['client'];
  let identity: Identity;
  let app: ReturnType<typeof createApp>;

  const build = (extra: Partial<WebappConfig> = {}) =>
    createApp(webDb, identity, { origin: ORIGIN, trustProxy: false, distDir: null, capabilities: CAPS, ...extra });
  const get = async <T>(path: string, headers: Record<string, string> = {}) => {
    const res = await app.request(`/api${path}`, { headers });
    return { status: res.status, body: (await res.json()) as T };
  };
  /** A write; without headers of its own it comes as a non-browser client sends it: no Origin, no Sec-Fetch-Site. */
  const post = async (path: string, body: unknown, headers: Record<string, string> = {}) => {
    const res = await app.request(`/api${path}`, { method: 'POST', body: JSON.stringify(body), headers: { ...JSON_TYPE, ...headers } });
    return { status: res.status, body: (await res.json()) as { ok?: true; error?: string } };
  };
  const handle = async () => (await get<MeResponse>('/me')).body.rsiHandle;

  before(async () => {
    await prepareDb(url);
    // db plays the importer and whatever filled the database before; the web app itself runs as qm_web
    ({ db, close: closeDb } = connectAs(url, 'qm_app'));
    ({ db: webDb, close: closeWeb, client } = connectAs(url, 'qm_web'));
    const snap = fixtureSnapshot();
    await runImport(db, snap, sha256(stableStringify(snap)), { dryRun: false, force: false, allowDowngrade: false, maxRetireRatio: 0.1, maxChangeRatio: 0.5 });
    await ensureGuild(db, G, 'Some Org');
    const settings = await updateGuildSettings(db, G, { memberRoleIds: [MEMBER_ROLE] });
    await syncMember(db, G, settings, OTHER, { userId: OTHER, displayName: 'other', roleIds: [MEMBER_ROLE], bot: false });
    identity = await localIdentity(webDb);
    app = build();
  });
  after(async () => { await closeDb?.(); await closeWeb?.(); });

  it('the fixed user exists once, however often the identity is made', async () => {
    await localIdentity(webDb);
    const found = await db.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM app.app_user WHERE user_id = ${LOCAL_USER_ID}`);
    assert.equal(found[0]!.n, 1);
  });

  it('every request is the fixed user: no cookie, no token, and neither is looked at', async () => {
    const { status, body } = await get<MeResponse>('/me');
    assert.equal(status, 200);
    assert.equal(body.userId, LOCAL_USER_ID);
    assert.equal(body.name, 'Local');
    assert.deepEqual(body.orgs, []);
    assert.deepEqual(body.privileges, []);
    for (const headers of [{ cookie: '__Host-qm_session=nope' }, { authorization: 'Bearer qmt_wrong' }, { authorization: 'Bearer qmt_wrong', 'x-qm-companion': '0.0.1' }]) {
      const res = await app.request('/api/me', { headers });
      assert.equal(res.status, 200, JSON.stringify(headers));
      assert.equal(((await res.json()) as MeResponse).userId, LOCAL_USER_ID);
      assert.deepEqual(res.headers.getSetCookie(), []);
    }
  });

  it('capabilities: answered without a login, never cached, within the rate limit per address', async () => {
    const res = await app.request('/api/capabilities');
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), CAPS);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    const limited = build({ rateLimit: { windowMs: 60_000, auth: 100, apiIp: 2, apiUser: 100 } });
    const codes = [];
    for (let i = 0; i < 3; i++) codes.push((await limited.request('/api/capabilities')).status);
    assert.deepEqual(codes, [200, 200, 429]);
  });

  it('writes: a non-browser client and the own origin pass, a web page of another origin or site is refused', async () => {
    // No Origin, no Sec-Fetch-Site: not a browser
    assert.deepEqual(await post('/profile', { rsiHandle: 'plain' }), { status: 200, body: { ok: true } });
    assert.equal(await handle(), 'plain');
    // The app's own SPA
    assert.equal((await post('/profile', { rsiHandle: 'spa' }, { origin: ORIGIN, 'sec-fetch-site': 'same-origin' })).status, 200);
    assert.equal((await post('/profile', { rsiHandle: 'old-browser' }, { origin: ORIGIN })).status, 200);
    assert.equal(await handle(), 'old-browser');
    // A web page: another origin, another site, the same site on another port, or a browser that names no origin
    for (const headers of [
      { origin: 'https://evil.test' },
      { origin: 'https://evil.test', 'sec-fetch-site': 'cross-site' },
      { 'sec-fetch-site': 'cross-site' },
      { origin: 'http://127.0.0.1:8443', 'sec-fetch-site': 'same-site' },
      { origin: 'null' },
      { 'sec-fetch-site': 'none' },
      // No token buys a way around it
      { origin: 'https://evil.test', authorization: 'Bearer qmt_anything' },
    ] as Record<string, string>[]) {
      const res = await post('/profile', { rsiHandle: 'evil' }, headers);
      assert.deepEqual(res, { status: 403, body: { error: 'cross-origin request refused' } }, JSON.stringify(headers));
    }
    assert.equal(await handle(), 'old-browser');
    // Writes take JSON only, as online
    const form = await app.request('/api/profile', { method: 'POST', body: 'rsiHandle=x', headers: { 'content-type': 'application/x-www-form-urlencoded' } });
    assert.equal(form.status, 415);
  });

  it('no login, no tokens: /auth/* and /api/token are not there', async () => {
    assert.equal((await app.request('/auth/login')).status, 404);
    assert.equal((await app.request('/auth/callback?code=x&state=y')).status, 404);
    assert.equal((await app.request('/auth/logout', { method: 'POST' })).status, 404);
    assert.deepEqual(await get('/token'), { status: 404, body: { error: 'not found' } });
    assert.deepEqual(await post('/token', {}), { status: 404, body: { error: 'not found' } });
    assert.ok(!app.routes.some((r) => r.path.startsWith('/auth/') && r.method !== 'ALL'));
  });

  it('no orgs: the org routes are not there, and no org parameter reaches an org the database holds', async () => {
    assert.deepEqual(await get(`/orgs/${G}/members`), { status: 404, body: { error: 'not found' } });
    assert.deepEqual(await get(`/orgs/${G}/blueprints`), { status: 404, body: { error: 'not found' } });
    assert.ok(!app.routes.some((r) => r.path.startsWith('/api/orgs')));
    // The existing membership checks refuse: the local user is in no org
    assert.deepEqual(await get(`/stock?scope=org&guildId=${G}`), { status: 403, body: { error: 'notMember' } });
    const metal = { subjectUuid: U.metal, locationUuid: U.station, quality: 400, amount: '1' };
    assert.deepEqual(await post('/stock/add', { ...metal, guildIds: [G] }), { status: 403, body: { error: 'notMember' } });
    assert.equal((await get<StockListResponse>('/stock?scope=personal')).body.batches.length, 0);
    assert.equal((await post('/stock/add', metal)).status, 200);
    const [batch] = (await get<StockListResponse>('/stock?scope=personal')).body.batches;
    assert.deepEqual(await post('/stock/share', { batchId: batch!.id, guildIds: [G] }), { status: 422, body: { error: 'holderNotMember' } });
    assert.deepEqual(await post('/stock/move', { batchId: batch!.id, amount: null, expected: '1', guildId: G, toOwnerUserId: OTHER }), { status: 403, body: { error: 'notMember' } });
    assert.deepEqual(await post('/stock/move', { batchId: batch!.id, amount: null, expected: '1', toOwnerUserId: OTHER }), { status: 422, body: { error: 'notAllowed' } });
    assert.equal((await post('/stock/remove', { batchId: batch!.id, amount: null, expected: '1' })).status, 200);
  });

  it('stock: the fixed user adds and lists', async () => {
    const added = await post('/stock/add', { subjectUuid: U.metal, locationUuid: U.station, quality: 612, amount: '2.5' });
    assert.deepEqual(added, { status: 200, body: { ok: true } });
    const { status, body } = await get<StockListResponse>('/stock?scope=personal');
    assert.equal(status, 200);
    const mine = body.batches.filter((b) => b.quality === 612);
    assert.equal(mine.length, 1);
    assert.equal(mine[0]!.quantity, '2.5');
    assert.equal(mine[0]!.holderUserId, LOCAL_USER_ID);
    assert.equal(mine[0]!.canChange, true);
    assert.deepEqual(mine[0]!.sharedIn, []);
    assert.equal((await post('/stock/remove', { batchId: mine[0]!.id, amount: null, expected: '2.5' })).status, 200);
  });

  it('history: a request with the companion header is labelled companion, any other webapp (a label, not a check)', async () => {
    const sources = async () => (await get<{ entries: { source: string; details?: { quality?: number } }[] }>('/history')).body.entries;
    const metal = { subjectUuid: U.metal, locationUuid: U.station, amount: '1' };
    assert.equal((await post('/stock/add', { ...metal, quality: 801 })).status, 200);
    assert.equal((await post('/stock/add', { ...metal, quality: 802 }, { 'x-qm-companion': '0.1.0' })).status, 200);
    const found = await sources();
    const [plain, companion] = [801, 802].map((q) => JSON.stringify(found.find((e) => JSON.stringify(e).includes(`${q}`))));
    assert.match(plain!, /"source":"webapp"/);
    assert.match(companion!, /"source":"companion"/);
  });

  describe('realtime', () => {
    let server: Server;
    let hub: RealtimeHub;
    let port: number;
    const sockets: WebSocket[] = [];

    before(async () => {
      hub = new RealtimeHub(webDb, identity, { origin: ORIGIN, trustProxy: false, pingMs: 100 }, () => {});
      await listenForChanges(client, hub, () => {});
      server = createServer((_req, res) => res.end());
      server.on('upgrade', (req, sock, head) => hub.handleUpgrade(req, sock, head));
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      port = (server.address() as AddressInfo).port;
    });
    after(async () => {
      for (const ws of sockets) ws.terminate();
      hub?.close();
      await new Promise((r) => server?.close(r));
    });

    const refused = (headers: Record<string, string>) => new Promise<number>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/api/ws`, { headers });
      ws.once('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0));
      ws.once('open', () => reject(new Error('handshake accepted')));
      ws.once('error', () => {});
    });

    it('a handshake without any cookie is the fixed user and hears about its stock; the socket stays open', async () => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/api/ws`, { headers: { origin: ORIGIN } });
      sockets.push(ws);
      const received: ServerMessage[] = [];
      let closed = false;
      ws.on('message', (data) => received.push(JSON.parse(data.toString()) as ServerMessage));
      ws.on('close', () => (closed = true));
      await new Promise<void>((resolve, reject) => {
        ws.once('open', () => resolve());
        ws.once('unexpected-response', (_req, res) => reject(new Error(`refused ${res.statusCode}`)));
      });
      assert.equal((await post('/stock/add', { subjectUuid: U.metal, locationUuid: U.station, quality: 733, amount: '1' })).status, 200);
      for (let i = 0; i < 100 && !received.some((m) => m.type === 'stock'); i++) await new Promise((r) => setTimeout(r, 10));
      assert.ok(received.some((m) => m.type === 'stock' && m.scope === 'personal'), JSON.stringify(received));
      // Several keepalives later: nothing ends this user's socket
      await new Promise((r) => setTimeout(r, 350));
      assert.equal(closed, false);
    });

    it('a web page of another origin gets no socket', async () => {
      assert.equal(await refused({ origin: 'https://evil.test' }), 403);
    });
  });
});
