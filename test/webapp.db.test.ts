// Runs against TEST_DATABASE_URL only; the web, bot, app and catalog schemas there are dropped and recreated.
// The user web app end to end through Hono (app.request), with Discord replaced on the HTTP level:
// openid-client's real state/PKCE handling runs, the fake token endpoint checks the PKCE verifier.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';
import { sql } from 'drizzle-orm';
import type { Db } from '../src/db/client.ts';
import { connectAs, prepareDb } from './roles.ts';
import { syncMember } from '../src/bot/roster.ts';
import { ensureGuild, updateGuildSettings } from '../src/bot/settings.ts';
import { createApp, type WebappConfig } from '../src/webapp/app.ts';
import { COMPANION_API, COMPANION_API_MIN, type Capabilities } from '../src/webapp/api-types.ts';
import { discordLogin } from '../src/webapp/discord.ts';
import { discordIdentity } from '../src/webapp/identity-discord.ts';
import { deleteExpiredSessions } from '../src/webapp/session.ts';

const url = process.env.TEST_DATABASE_URL;
const ORIGIN = 'https://qm.test';
const USER = '730000000000000001';
const G = '700000000000000009';
const MEMBER_ROLE = '710000000000000011';

/** A built SPA in a temp dir: index, one hashed asset, two dotfiles that must never be served. */
function spaDist() {
  const dir = mkdtempSync(join(tmpdir(), 'qm-spa-'));
  mkdirSync(join(dir, 'assets'));
  writeFileSync(join(dir, 'index.html'), '<!doctype html><title>spa-index</title>');
  writeFileSync(join(dir, 'assets', 'app-1234.js'), 'console.log(1)');
  writeFileSync(join(dir, '.env'), 'SECRET=1');
  writeFileSync(join(dir, 'assets', '.secret'), 'SECRET=2');
  return dir;
}

/** Fake Discord: remembers the PKCE challenge of the last authorize URL and checks the verifier. */
function fakeDiscord() {
  const fake = {
    challenge: '', codes: new Set(['good']), userId: USER,
    globalName: 'Tester' as string | null, avatar: null as string | null,
  };
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const target = String(input instanceof Request ? input.url : input);
    if (target.endsWith('/oauth2/token')) {
      const body = new URLSearchParams(String(init?.body));
      const s256 = createHash('sha256').update(body.get('code_verifier') ?? '').digest('base64url');
      const ok = body.get('grant_type') === 'authorization_code' && fake.codes.has(body.get('code') ?? '')
        && s256 === fake.challenge && body.get('redirect_uri') === `${ORIGIN}/auth/callback`
        && body.get('client_id') === 'cid' && body.get('client_secret') === 'secret';
      return ok
        ? Response.json({ access_token: 'at', token_type: 'Bearer', expires_in: 604800, scope: 'identify' })
        : Response.json({ error: 'invalid_grant' }, { status: 400 });
    }
    if (target.endsWith('/users/@me')) {
      const auth = new Headers(init?.headers).get('authorization');
      return auth === 'Bearer at'
        ? Response.json({ id: fake.userId, username: 'tester', global_name: fake.globalName, avatar: fake.avatar })
        : new Response('unauthorized', { status: 401 });
    }
    throw new Error(`unexpected fetch ${target}`);
  }) as typeof fetch;
  return { fake, fetchFn };
}

describe('user web app (database)', { skip: url ? false : 'TEST_DATABASE_URL not set' }, () => {
  let db: Db;
  let close: () => Promise<void>;
  let appDb: Db;
  let closeApp: () => Promise<void>;
  let discord: ReturnType<typeof fakeDiscord>;

  const build = (extra: Partial<WebappConfig> = {}) => createApp(db, discordIdentity(db, discordLogin({
    clientId: 'cid', clientSecret: 'secret', redirectUri: `${ORIGIN}/auth/callback`, fetch: discord.fetchFn,
  })), { origin: ORIGIN, trustProxy: false, distDir: null, capabilities: { login: 'discord', orgs: true, uex: true }, ...extra });
  let app: ReturnType<typeof build>;

  const cookiesOf = (res: Response) => res.headers.getSetCookie();
  const cookieValue = (res: Response, name: string) =>
    cookiesOf(res).map((c) => c.split(';')[0]!).find((c) => c.startsWith(`${name}=`))?.slice(name.length + 1);
  const sessions = async () => (await db.execute<{ token_hash: string; user_id: string }>(sql`SELECT token_hash, user_id FROM web.session`));

  /** Runs /auth/login; returns the authorize URL and the OAuth cookie. */
  const startLogin = async () => {
    const res = await app.request('/auth/login');
    assert.equal(res.status, 302);
    const authorize = new URL(res.headers.get('location')!);
    discord.fake.challenge = authorize.searchParams.get('code_challenge')!;
    return { res, authorize, oauth: cookieValue(res, '__Host-qm_oauth')! };
  };
  const callback = (query: string, cookie: string) => app.request(`/auth/callback?${query}`, { headers: { cookie } });
  /** Full login; returns the session token. */
  const loginAs = async (userId = USER) => {
    discord.fake.userId = userId;
    const { authorize, oauth } = await startLogin();
    const res = await callback(`code=good&state=${authorize.searchParams.get('state')}`, `__Host-qm_oauth=${oauth}`);
    assert.equal(res.headers.get('location'), '/');
    return cookieValue(res, '__Host-qm_session')!;
  };
  const me = (token: string) => app.request('/api/me', { headers: { cookie: `__Host-qm_session=${token}` } });
  const sameOrigin = { origin: ORIGIN, 'sec-fetch-site': 'same-origin' };

  before(async () => {
    await prepareDb(url);
    ({ db, close } = connectAs(url, 'qm_web'));
    ({ db: appDb, close: closeApp } = connectAs(url, 'qm_app')); // fixtures outside the web app's rights
  });
  beforeEach(async () => {
    await db.execute(sql`DELETE FROM web.session`);
    discord = fakeDiscord();
    app = build();
  });
  after(async () => { await close?.(); await closeApp?.(); });

  it('sets the security headers, no HSTS (Caddy), no caching of API responses', async () => {
    const res = await app.request('/api/me');
    const csp = res.headers.get('content-security-policy') ?? '';
    for (const part of ["default-src 'self'", "script-src 'self'", "frame-ancestors 'none'", "object-src 'none'", "base-uri 'none'"]) {
      assert.ok(csp.includes(part), part);
    }
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(res.headers.get('x-frame-options'), 'DENY');
    assert.equal(res.headers.get('referrer-policy'), 'no-referrer');
    assert.equal(res.headers.get('strict-transport-security'), null);
    assert.equal(res.headers.get('cache-control'), 'no-store');
  });

  it('every API route needs a session, unknown ones too; only the capabilities answer without', async () => {
    const open = app.routes.filter((r) => r.path === '/api/capabilities');
    assert.deepEqual(open.map((r) => r.method), ['GET']);
    const routes = app.routes.filter((r) => r.path.startsWith('/api') && r.method !== 'ALL' && !open.includes(r));
    assert.ok(routes.length > 0);
    const caps = await app.request('/api/capabilities');
    assert.equal(caps.status, 200);
    assert.deepEqual(await caps.json(), { login: 'discord', orgs: true, uex: true, game: null, companionApi: { min: COMPANION_API_MIN, max: COMPANION_API } });
    assert.equal(caps.headers.get('cache-control'), 'no-store');
    // Nothing else of that path is open
    assert.equal((await app.request('/api/capabilities', { method: 'POST', body: '{}', headers: { ...sameOrigin, 'content-type': 'application/json' } })).status, 401);
    assert.equal((await app.request('/api/capabilities/x')).status, 401);
    for (const r of [...routes, { method: 'GET', path: '/api/does-not-exist' }]) {
      const res = await app.request(r.path, { method: r.method, headers: sameOrigin });
      assert.equal(res.status, 401, `${r.method} ${r.path}`);
    }
    const bogus = await me('not-a-session');
    assert.equal(bogus.status, 401);
    assert.ok(cookiesOf(bogus).some((c) => c.startsWith('__Host-qm_session=;')), 'unknown cookie is cleared');
  });

  it('login: PKCE + state to Discord, scope identify, OAuth cookie locked down', async () => {
    const { res, authorize } = await startLogin();
    assert.equal(authorize.origin + authorize.pathname, 'https://discord.com/oauth2/authorize');
    const p = authorize.searchParams;
    assert.equal(p.get('response_type'), 'code');
    assert.equal(p.get('client_id'), 'cid');
    assert.equal(p.get('scope'), 'identify');
    assert.equal(p.get('redirect_uri'), `${ORIGIN}/auth/callback`);
    assert.equal(p.get('code_challenge_method'), 'S256');
    assert.ok((p.get('state') ?? '').length >= 32);
    const cookie = cookiesOf(res).find((c) => c.startsWith('__Host-qm_oauth='))!;
    for (const attr of ['HttpOnly', 'Secure', 'SameSite=Lax', 'Path=/', 'Max-Age=600']) assert.ok(cookie.includes(attr), attr);
    assert.ok(!/domain=/i.test(cookie));
  });

  it('callback: creates a hashed session and the user row, me answers', async () => {
    await appDb.execute(sql`DELETE FROM app.app_user WHERE user_id = ${USER}`);
    const token = await loginAs();
    const rows = await sessions();
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.token_hash, createHash('sha256').update(token).digest('hex'));
    assert.notEqual(rows[0]!.token_hash, token);
    assert.equal((await db.execute(sql`SELECT 1 FROM app.app_user WHERE user_id = ${USER}`)).length, 1);
    const res = await me(token);
    assert.equal(res.status, 200);
    // Works without any org: profile from the login, default avatar
    assert.deepEqual(await res.json(), {
      userId: USER, name: 'Tester', username: 'tester',
      avatarUrl: `https://cdn.discordapp.com/embed/avatars/${(BigInt(USER) >> 22n) % 6n}.png`,
      orgs: [], rsiHandle: null, langOverride: null, privileges: [],
    });
  });

  it('session cookie: __Host-, HttpOnly, Secure, SameSite=Lax', async () => {
    const { authorize, oauth } = await startLogin();
    const res = await callback(`code=good&state=${authorize.searchParams.get('state')}`, `__Host-qm_oauth=${oauth}`);
    const cookie = cookiesOf(res).find((c) => c.startsWith('__Host-qm_session='))!;
    for (const attr of ['HttpOnly', 'Secure', 'SameSite=Lax', 'Path=/']) assert.ok(cookie.includes(attr), attr);
    assert.ok(cookiesOf(res).some((c) => c.startsWith('__Host-qm_oauth=;')), 'OAuth cookie is cleared');
  });

  it('login returns to the deep link it started from, never to another host', async () => {
    const cases: Array<[string, string]> = [
      ['/stock?scope=123456789012345678', '/stock?scope=123456789012345678'],
      ['/crafting?add=00000000-0000-0000-0000-000000000001', '/crafting?add=00000000-0000-0000-0000-000000000001'],
      ['//evil.example', '/'],
      ['/\\evil.example', '/'],
      ['https://evil.example/', '/'],
      ['stock', '/'],
    ];
    for (const [returnTo, location] of cases) {
      const start = await app.request(`/auth/login?returnTo=${encodeURIComponent(returnTo)}`);
      const authorize = new URL(start.headers.get('location')!);
      discord.fake.challenge = authorize.searchParams.get('code_challenge')!;
      const res = await callback(`code=good&state=${authorize.searchParams.get('state')}`, `__Host-qm_oauth=${cookieValue(start, '__Host-qm_oauth')}`);
      assert.equal(res.headers.get('location'), location, returnTo);
    }
  });

  it('callback refuses a wrong state, a missing OAuth cookie, a wrong verifier, a bad code and a denial', async () => {
    const { authorize, oauth } = await startLogin();
    const state = authorize.searchParams.get('state')!;
    const [, verifier] = oauth.split('.');
    const cases: Array<[string, string, string]> = [
      [`code=good&state=wrong`, `__Host-qm_oauth=${oauth}`, '/?login=failed'],
      [`code=good&state=${state}`, '', '/?login=failed'],
      [`code=good&state=${state}`, `__Host-qm_oauth=${state}.${verifier!.slice(1)}x`, '/?login=failed'],
      [`code=bad&state=${state}`, `__Host-qm_oauth=${oauth}`, '/?login=failed'],
      [`error=access_denied&state=${state}`, `__Host-qm_oauth=${oauth}`, '/?login=denied'],
    ];
    for (const [query, cookie, location] of cases) {
      const res = await callback(query, cookie);
      assert.equal(res.headers.get('location'), location, query);
      assert.equal(cookieValue(res, '__Host-qm_session'), undefined, query);
    }
    assert.equal((await sessions()).length, 0);
  });

  it('a new login replaces the session of this browser', async () => {
    const first = await loginAs();
    const { authorize, oauth } = await startLogin();
    const res = await callback(`code=good&state=${authorize.searchParams.get('state')}`,
      `__Host-qm_oauth=${oauth}; __Host-qm_session=${first}`);
    assert.notEqual(cookieValue(res, '__Host-qm_session'), first);
    assert.equal((await sessions()).length, 1);
    assert.equal((await me(first)).status, 401);
  });

  it('me: active memberships from the roster', async () => {
    await ensureGuild(appDb, G, 'Web Org');
    const settings = await updateGuildSettings(appDb, G, { memberRoleIds: [MEMBER_ROLE] });
    await syncMember(appDb, G, settings, USER, { userId: USER, displayName: 'Tess', roleIds: [MEMBER_ROLE], bot: false });
    const token = await loginAs();
    const orgs = async () => ((await (await me(token)).json()) as { orgs: unknown[] }).orgs;
    assert.deepEqual(await orgs(), [{ guildId: G, name: 'Web Org', displayName: 'Tess' }]);
    // Losing the role takes effect without a new login
    await syncMember(appDb, G, settings, USER, { userId: USER, displayName: 'Tess', roleIds: [], bot: false });
    assert.deepEqual(((await (await me(token)).json()) as { orgs: unknown[] }).orgs, []);
  });

  it('profile: avatar URL from the hash, username when there is no global name, refreshed by a new login', async () => {
    discord.fake.globalName = null;
    discord.fake.avatar = 'a_0123456789abcdef0123456789abcdef';
    const body = (await (await me(await loginAs())).json()) as { name: string; avatarUrl: string };
    assert.equal(body.name, 'tester');
    assert.equal(body.avatarUrl, `https://cdn.discordapp.com/avatars/${USER}/a_0123456789abcdef0123456789abcdef.png?size=64`);
    discord.fake.globalName = 'Renamed';
    assert.equal(((await (await me(await loginAs())).json()) as { name: string }).name, 'Renamed');
  });

  it('refuses a malformed avatar hash from Discord (it goes into a URL)', async () => {
    discord.fake.avatar = '../../evil';
    const { authorize, oauth } = await startLogin();
    const res = await callback(`code=good&state=${authorize.searchParams.get('state')}`, `__Host-qm_oauth=${oauth}`);
    assert.equal(res.headers.get('location'), '/?login=failed');
  });

  it('recreates a user row the roster cleanup removed while logged in', async () => {
    const token = await loginAs();
    await appDb.execute(sql`DELETE FROM app.app_user WHERE user_id = ${USER}`);
    assert.equal((await me(token)).status, 200);
    assert.equal((await db.execute(sql`SELECT 1 FROM app.app_user WHERE user_id = ${USER}`)).length, 1);
  });

  it('expires idle sessions after 14 days and every session after 30', async () => {
    const idle = await loginAs();
    const old = await loginAs('730000000000000002');
    const hash = (t: string) => createHash('sha256').update(t).digest('hex');
    await db.execute(sql`UPDATE web.session SET last_seen_at = now() - interval '15 days' WHERE token_hash = ${hash(idle)}`);
    await db.execute(sql`UPDATE web.session SET expires_at = now() - interval '1 second' WHERE token_hash = ${hash(old)}`);
    assert.equal((await me(idle)).status, 401);
    assert.equal((await me(old)).status, 401);
    assert.equal(await deleteExpiredSessions(db), 2);
  });

  it('logout: refuses cross-origin requests, deletes the session', async () => {
    const token = await loginAs();
    const cookie = `__Host-qm_session=${token}`;
    const foreign: Record<string, string>[] = [{ origin: 'https://evil.test' }, { 'sec-fetch-site': 'same-site', origin: ORIGIN }, {}];
    for (const headers of foreign) {
      const res = await app.request('/auth/logout', { method: 'POST', headers: { cookie, ...headers } });
      assert.equal(res.status, 403, JSON.stringify(headers));
    }
    assert.equal((await me(token)).status, 200);
    const res = await app.request('/auth/logout', { method: 'POST', headers: { cookie, ...sameOrigin } });
    assert.equal(res.status, 204);
    assert.equal((await sessions()).length, 0);
    assert.equal((await me(token)).status, 401);
  });

  it('API writes take JSON only', async () => {
    const token = await loginAs();
    const res = await app.request('/api/me', {
      method: 'POST', body: 'x', headers: { cookie: `__Host-qm_session=${token}`, 'content-type': 'text/plain', ...sameOrigin },
    });
    assert.equal(res.status, 415);
  });

  it('rate limits the login', async () => {
    app = build({ rateLimit: { windowMs: 60_000, auth: 3, apiIp: 100, apiUser: 100 } });
    const codes = [];
    for (let i = 0; i < 4; i++) codes.push((await app.request('/auth/login')).status);
    assert.deepEqual(codes, [302, 302, 302, 429]);
  });

  it('rate limits the API per address, whatever session cookie is sent, and per user', async () => {
    app = build({ rateLimit: { windowMs: 60_000, auth: 100, apiIp: 3, apiUser: 100 } });
    const codes = [];
    for (let i = 0; i < 4; i++) codes.push((await me(`random-${i}`)).status);
    assert.deepEqual(codes, [401, 401, 401, 429]);

    app = build({ rateLimit: { windowMs: 60_000, auth: 100, apiIp: 100, apiUser: 2 } });
    // Two sessions of the same user share the user's bucket
    const [a, b] = [await loginAs(), await loginAs()];
    assert.deepEqual([(await me(a)).status, (await me(b)).status, (await me(a)).status], [200, 200, 429]);
  });

  it('answers unknown API routes with JSON 404, also when logged in', async () => {
    app = build({ distDir: spaDist() });
    const token = await loginAs();
    const cookie = `__Host-qm_session=${token}`;
    for (const method of ['GET', 'POST']) {
      const res = await app.request('/api/does-not-exist', {
        method, headers: { cookie, 'content-type': 'application/json', ...sameOrigin }, body: method === 'POST' ? '{}' : undefined,
      });
      assert.equal(res.status, 404, method);
      assert.deepEqual(await res.json(), { error: 'not found' });
    }
  });

  it('serves the SPA: index never cached, hashed assets for good, no dotfiles', async () => {
    app = build({ distDir: spaDist() });
    for (const path of ['/', '/index.html', '/some/deep/link']) {
      const res = await app.request(path);
      assert.equal(res.status, 200, path);
      assert.equal(res.headers.get('cache-control'), 'no-cache', path);
      assert.ok((await res.text()).includes('spa-index'), path);
    }
    const asset = await app.request('/assets/app-1234.js');
    assert.equal(await asset.text(), 'console.log(1)');
    assert.equal(asset.headers.get('cache-control'), 'public, max-age=31536000, immutable');
    for (const path of ['/.env', '/assets/.secret']) {
      assert.ok(!(await (await app.request(path)).text()).includes('SECRET'), path);
    }
  });

  describe('API token (companion app)', () => {
    const json = { 'content-type': 'application/json' };
    const asUser = (token: string, path: string, method = 'GET') => app.request(`/api${path}`, method === 'GET'
      ? { headers: { cookie: `__Host-qm_session=${token}` } }
      : { method, headers: { cookie: `__Host-qm_session=${token}`, ...json, ...sameOrigin }, body: '{}' });
    const companion = { 'x-qm-companion-api': String(COMPANION_API) };
    const asToken = (token: string, path: string, body?: unknown) => app.request(`/api${path}`, body === undefined
      ? { headers: { authorization: `Bearer ${token}`, ...companion } }
      : { method: 'POST', headers: { authorization: `Bearer ${token}`, ...companion, ...json }, body: JSON.stringify(body) });
    const create = async (session: string) => {
      const res = await asUser(session, '/token', 'POST');
      assert.equal(res.status, 200);
      return ((await res.json()) as { token: string }).token;
    };

    beforeEach(async () => {
      await db.execute(sql`DELETE FROM web.api_token`);
    });

    it('is created in the session, stored as a hash only, and then acts as the user', async () => {
      const session = await loginAs();
      assert.deepEqual(await (await asUser(session, '/token')).json(), { createdAt: null, lastUsedAt: null });
      const token = await create(session);
      assert.match(token, /^qmt_[A-Za-z0-9_-]{43}$/);
      const [row] = await db.execute<{ token_hash: string }>(sql`SELECT token_hash FROM web.api_token`);
      assert.equal(row!.token_hash, createHash('sha256').update(token).digest('hex'));

      const meRes = await asToken(token, '/me');
      assert.equal(meRes.status, 200);
      const body = (await meRes.json()) as { userId: string; name: string };
      assert.equal(body.userId, USER);
      assert.equal(body.name, 'Tester');
      const info = (await (await asUser(session, '/token')).json()) as { createdAt: string | null; lastUsedAt: string | null };
      assert.ok(info.createdAt && info.lastUsedAt, 'use is recorded');
    });

    it('a new token replaces the old one', async () => {
      const session = await loginAs();
      const first = await create(session);
      const second = await create(session);
      assert.notEqual(first, second);
      assert.equal((await asToken(first, '/me')).status, 401);
      assert.equal((await asToken(second, '/me')).status, 200);
    });

    it('token writes need no Origin; a bad token is 401, never a cookie fallback; the cookie path keeps its CSRF check', async () => {
      const session = await loginAs();
      const token = await create(session);
      // Passes the CSRF check and reaches the route (validation)
      assert.equal((await asToken(token, '/blueprints/add', { uuid: 'not-a-uuid' })).status, 400);
      const bad = await app.request('/api/me', { headers: { authorization: 'Bearer qmt_wrong', ...companion, cookie: `__Host-qm_session=${session}` } });
      assert.equal(bad.status, 401);
      const csrf = await app.request('/api/profile', {
        method: 'POST', headers: { cookie: `__Host-qm_session=${session}`, ...json }, body: JSON.stringify({}),
      });
      assert.equal(csrf.status, 403);
    });

    it('cannot see or mint tokens itself', async () => {
      const token = await create(await loginAs());
      assert.equal((await asToken(token, '/token')).status, 403);
      assert.equal((await asToken(token, '/token', {})).status, 403);
    });
  });

  describe('companion API contract', () => {
    const tokenFor = async (session: string) => ((await (await app.request('/api/token', {
      method: 'POST', headers: { cookie: `__Host-qm_session=${session}`, 'content-type': 'application/json', ...sameOrigin }, body: '{}',
    })).json()) as { token: string }).token;
    const meWith = (token: string, headers: Record<string, string> = {}) => app.request('/api/me', {
      headers: { authorization: `Bearer ${token}`, ...headers },
    });
    const BAD = `qmt_${'x'.repeat(43)}`;
    const outdated = { error: 'companionOutdated', apiMin: COMPANION_API_MIN };

    it('an app without a contract number, or below the minimum, gets 426 and nothing else; an equal one works', async () => {
      const token = await tokenFor(await loginAs());
      // The app version header is only a label: it decides nothing
      for (const headers of [{}, { 'x-qm-companion': '99.0.0' }, { 'x-qm-companion-api': '0' }, { 'x-qm-companion-api': 'garbage' }, { 'x-qm-companion-api': '' }, { 'x-qm-companion-api': '-1' }] as Record<string, string>[]) {
        const res = await meWith(token, headers);
        assert.equal(res.status, 426, JSON.stringify(headers));
        assert.deepEqual(await res.json(), outdated);
      }
      assert.equal((await meWith(token, { 'x-qm-companion-api': String(COMPANION_API_MIN), 'x-qm-companion': '0.0.1' })).status, 200);
      assert.equal((await meWith(token, { 'x-qm-companion-api': String(COMPANION_API) })).status, 200);
    });

    it('an app built for a newer contract gets 409 with the server\'s number', async () => {
      const token = await tokenFor(await loginAs());
      const res = await meWith(token, { 'x-qm-companion-api': String(COMPANION_API + 1) });
      assert.equal(res.status, 409);
      assert.deepEqual(await res.json(), { error: 'serverOutdated', apiMax: COMPANION_API });
    });

    it('the check runs before the token check: a bad token gets the 426 or 409, only a fitting app gets the 401', async () => {
      assert.deepEqual(await (await meWith(BAD)).json(), outdated);
      assert.equal((await meWith(BAD, { 'x-qm-companion-api': String(COMPANION_API + 1) })).status, 409);
      assert.equal((await meWith(BAD, { 'x-qm-companion-api': String(COMPANION_API) })).status, 401);
      // Whatever the Authorization header holds, it makes the request the companion's
      const basic = await app.request('/api/me', { headers: { authorization: 'Basic abc' } });
      assert.equal(basic.status, 426);
      // Writes and unknown routes are held to it as well
      const write = await app.request('/api/blueprints/add', {
        method: 'POST', headers: { authorization: `Bearer ${BAD}`, 'content-type': 'application/json' }, body: '{}',
      });
      assert.equal(write.status, 426);
      assert.equal((await app.request('/api/does-not-exist', { headers: { authorization: `Bearer ${BAD}` } })).status, 426);
    });

    it('the web app\'s own requests are not touched: a session needs no number, and a number alone does not make a request the companion\'s', async () => {
      const session = await loginAs();
      const cookie = { cookie: `__Host-qm_session=${session}` };
      assert.equal((await app.request('/api/me', { headers: cookie })).status, 200);
      assert.equal((await app.request('/api/me', { headers: { ...cookie, 'x-qm-companion': '0.0.1' } })).status, 200);
      assert.equal((await app.request('/api/me', { headers: { ...cookie, 'x-qm-companion-api': '99' } })).status, 200);
      assert.equal((await app.request('/api/me')).status, 401);
      // The capabilities are the way to find out, so no check
      const caps = await app.request('/api/capabilities', { headers: { authorization: `Bearer ${BAD}` } });
      assert.equal(caps.status, 200);
    });

    it('the capabilities carry the accepted range', async () => {
      const caps = (await (await app.request('/api/capabilities')).json()) as Capabilities;
      assert.deepEqual(caps.companionApi, { min: COMPANION_API_MIN, max: COMPANION_API });
    });

    it('the server hosts no release any more: the release info is a 404, the downloads and the update feed fall to the page', async () => {
      const session = await loginAs();
      const cookie = { cookie: `__Host-qm_session=${session}` };
      const token = await tokenFor(session);
      const spa = build({ distDir: spaDist() });
      const api = { 'x-qm-companion-api': String(COMPANION_API) };
      for (const headers of [cookie, { authorization: `Bearer ${token}`, ...api }]) {
        const res = await spa.request('/api/companion', { headers });
        assert.deepEqual([res.status, await res.json()], [404, { error: 'not found' }]);
      }
      for (const path of ['/downloads/companion/latest.json', '/downloads/companion/QM_x64-setup.exe', '/downloads/companion/companion.json']) {
        for (const headers of [{}, cookie, { authorization: `Bearer ${token}`, ...api }]) {
          const res = await spa.request(path, { headers });
          assert.equal(res.status, 200, path);
          assert.ok((await res.text()).includes('spa-index'), path);
        }
      }
    });

    it('the game\'s English texts need the companion\'s login; without a catalog they are a 404 noCatalog', async () => {
      assert.equal((await app.request('/api/companion/locale')).status, 401);
      const token = await tokenFor(await loginAs());
      const res = await meWith(token, { 'x-qm-companion-api': String(COMPANION_API) });
      assert.equal(res.status, 200);
      const locale = await app.request('/api/companion/locale', { headers: { authorization: `Bearer ${token}`, 'x-qm-companion-api': String(COMPANION_API) } });
      assert.deepEqual([locale.status, await locale.json()], [404, { error: 'noCatalog' }]);
      // The version check applies to this route like to the others
      assert.equal((await app.request('/api/companion/locale', { headers: { authorization: `Bearer ${token}` } })).status, 426);
    });
  });

  describe('item thumbnails', () => {
    const UUID = '0b6c4c0e-1f4a-4c5e-9d3a-2a1f0c9e8d7b';
    const thumbsDir = (manifest: Record<string, string> = { [UUID]: 'a1b2c3d4' }) => {
      const dir = mkdtempSync(join(tmpdir(), 'qm-thumbs-'));
      for (const size of ['s', 'm', 'l']) {
        mkdirSync(join(dir, size));
        writeFileSync(join(dir, size, `${UUID}.a1b2c3d4.avif`), `avif-${size}`);
        writeFileSync(join(dir, size, `${UUID}.ffffffff.avif`), 'stale');
      }
      writeFileSync(join(dir, 'thumbs.json'), JSON.stringify(manifest));
      return dir;
    };

    it('serves the manifest’s files without login, cached for good', async () => {
      app = build({ thumbsDir: thumbsDir() });
      const res = await app.request(`/thumbs/m/${UUID}.a1b2c3d4.avif`);
      assert.equal(res.status, 200);
      assert.equal(await res.text(), 'avif-m');
      assert.equal(res.headers.get('content-type'), 'image/avif');
      assert.equal(res.headers.get('cache-control'), 'public, max-age=31536000, immutable');
    });

    it('answers 404 for other hashes, sizes, names and without a manifest', async () => {
      app = build({ thumbsDir: thumbsDir() });
      for (const path of [`m/${UUID}.ffffffff.avif`, `x/${UUID}.a1b2c3d4.avif`, `constructor/${UUID}.a1b2c3d4.avif`,
        'm/thumbs.json', `m/..%2Fthumbs.json`, `m/${UUID.toUpperCase()}.a1b2c3d4.avif`]) {
        assert.equal((await app.request(`/thumbs/${path}`)).status, 404, path);
      }
      app = build({ thumbsDir: thumbsDir({}) });
      assert.equal((await app.request(`/thumbs/s/${UUID}.a1b2c3d4.avif`)).status, 404, 'not in the manifest');
      app = build();
      assert.equal((await app.request(`/thumbs/s/${UUID}.a1b2c3d4.avif`)).status, 404, 'no thumbnails');
    });
  });

  it('builds SQL from templates only (no sql.raw in the web app)', () => {
    const dir = new URL('../src/webapp/', import.meta.url);
    for (const file of readdirSync(dir).filter((f) => f.endsWith('.ts'))) {
      assert.ok(!readFileSync(new URL(file, dir), 'utf8').includes('sql.raw'), file);
    }
  });
});
