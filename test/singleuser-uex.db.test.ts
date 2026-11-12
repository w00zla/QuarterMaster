// Runs against TEST_DATABASE_URL only; the ext, web, bot, app and catalog schemas there are dropped and recreated.
// The singleuser UEX pull: the puller (fake fetch, manual timers and clock), its routes, the capabilities following the
// key, the game version in the capabilities, and /api/me of the local user. No request leaves the process.
import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, describe, it, mock } from 'node:test';
import { sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { runImport } from '../src/catalog/import/apply.ts';
import { sha256, stableStringify } from '../src/catalog/import/plan.ts';
import type { Db } from '../src/db/client.ts';
import { UEX_ENDPOINTS } from '../src/ext/uex.ts';
import { createUexPuller, type UexTimers } from '../src/singleuser/uex.ts';
import { mountUexRoutes } from '../src/singleuser/uex-routes.ts';
import { COMPANION_API, COMPANION_API_MIN, type Capabilities, type MeResponse, type UexState } from '../src/webapp/api-types.ts';
import { createApp, type ApiApp } from '../src/webapp/app.ts';
import { localIdentity } from '../src/webapp/identity-local.ts';
import { fixtureSnapshot } from './fixtures.ts';
import { connectAs, prepareDb } from './roles.ts';

const url = process.env.TEST_DATABASE_URL;
const N = UEX_ENDPOINTS.length;
const T0 = Date.parse('2026-11-11T10:00:00.000Z');

type Answer = { status?: number; throws?: boolean; rows?: unknown[] };

describe('singleuser UEX', { skip: url ? false : 'TEST_DATABASE_URL not set' }, () => {
  let db: Db;
  let webDb: Db;
  let closeDb: () => Promise<void>;
  let closeWeb: () => Promise<void>;

  before(async () => {
    await prepareDb(url);
    ({ db, close: closeDb } = connectAs(url, 'qm_app'));
    ({ db: webDb, close: closeWeb } = connectAs(url, 'qm_web'));
    // pullUex logs every endpoint
    mock.method(console, 'log', () => {});
    mock.method(console, 'error', () => {});
  });
  after(async () => {
    mock.restoreAll();
    await closeDb?.();
    await closeWeb?.();
  });
  beforeEach(() => db.execute(sql`DELETE FROM ext.snapshot`));

  /** A puller with a fake UEX, a manual clock and manual timers. `serve` decides each endpoint's answer. */
  function harness(initial: { uexKey?: string | null; uexIntervalMinutes?: number } = {}) {
    const settings = { uexKey: initial.uexKey ?? null, uexIntervalMinutes: initial.uexIntervalMinutes ?? 15 };
    const requests: { endpoint: string; auth: string }[] = [];
    const logs: string[] = [];
    let maintained = 0;
    let clock = T0;
    let nextTimer = 1;
    const timers = new Map<number, { run: () => void; ms: number }>();
    let answer: (endpoint: string) => Answer = () => ({ rows: [{ id: 1 }] });
    // Holds every request until released (or aborted)
    let gate: Promise<void> | null = null;
    const fake = (async (input: string | URL | Request, init?: RequestInit) => {
      const endpoint = String(input).split('/').at(-2)!;
      requests.push({ endpoint, auth: new Headers(init?.headers).get('authorization') ?? '' });
      if (gate) {
        await Promise.race([gate, new Promise<never>((_, reject) => {
          if (init?.signal?.aborted) reject(new Error('aborted'));
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        })]);
      }
      const a = answer(endpoint);
      if (a.throws) throw new TypeError('fetch failed');
      const status = a.status ?? 200;
      return new Response(JSON.stringify(status === 200 ? { status: 'ok', data: a.rows ?? [] } : { status: 'error' }), { status });
    }) as typeof fetch;
    const timerApi: UexTimers = {
      setTimeout: (run, ms) => {
        const id = nextTimer++;
        timers.set(id, { run, ms });
        return id;
      },
      clearTimeout: (handle) => { timers.delete(handle as number); },
    };
    const puller = createUexPuller({
      db, maintain: async () => { maintained++; }, settings: () => ({ ...settings }), fetch: fake,
      log: (m) => logs.push(m), now: () => new Date(clock), timers: timerApi,
    });
    return {
      puller, settings, requests, logs, timers,
      maintained: () => maintained,
      serve: (f: (endpoint: string) => Answer) => { answer = f; },
      hold: () => { let release!: () => void; gate = new Promise<void>((r) => { release = r; }); return () => { gate = null; release(); }; },
      advance: (ms: number) => { clock += ms; },
      /** Runs the one pending timer and waits for the pull it starts. */
      async fire() {
        const [id, t] = [...timers.entries()][0]!;
        timers.delete(id);
        t.run();
        // Until the pull it started is over
        do await new Promise((r) => setTimeout(r, 5)); while (puller.state().phase === 'pulling');
      },
    };
  }

  describe('the puller', () => {
    it('without a key: off, no request, no timer', async () => {
      const h = harness();
      await h.puller.start();
      assert.deepEqual(h.puller.state(), { phase: 'off', lastPull: null, nextPull: null, last: null });
      await h.puller.pullNow();
      assert.equal(h.requests.length, 0);
      assert.equal(h.timers.size, 0);
      await h.puller.stop();
    });

    it('with a key: pulls at start with that key, stores, maintains, waits the interval', async () => {
      const h = harness({ uexKey: 'my-key' });
      await h.puller.start();
      assert.deepEqual(h.requests.map((r) => r.endpoint), [...UEX_ENDPOINTS]);
      assert.ok(h.requests.every((r) => r.auth === 'Bearer my-key'));
      assert.deepEqual(h.puller.state(), {
        phase: 'idle', lastPull: new Date(T0).toISOString(), nextPull: new Date(T0 + 15 * 60_000).toISOString(),
        last: { outcome: 'ok', at: new Date(T0).toISOString(), changed: N },
      });
      assert.equal(h.maintained(), 1);
      assert.equal((await db.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM ext.snapshot`))[0]!.n, N);
      assert.deepEqual([...h.timers.values()].map((t) => t.ms), [15 * 60_000]);
      assert.match(h.logs.at(-1)!, /^uex pull: ok, 5 changed, \d+ ms$/);
      await h.puller.stop();
    });

    it('every interval; maintain only after a pull that changed something', async () => {
      const h = harness({ uexKey: 'k', uexIntervalMinutes: 30 });
      await h.puller.start();
      assert.deepEqual([...h.timers.values()].map((t) => t.ms), [30 * 60_000]);
      h.advance(30 * 60_000);
      await h.fire();
      assert.equal(h.requests.length, 2 * N);
      assert.deepEqual(h.puller.state().last, { outcome: 'ok', at: new Date(T0 + 30 * 60_000).toISOString(), changed: 0 });
      assert.equal(h.maintained(), 1);
      h.serve(() => ({ rows: [{ id: 2 }] }));
      await h.fire();
      assert.equal(h.maintained(), 2);
      assert.equal(h.puller.state().last?.changed, N);
      assert.equal(h.timers.size, 1);
      await h.puller.stop();
    });

    it('pullNow is single flight and the state is pulling at once', async () => {
      const h = harness({ uexKey: 'k' });
      await h.puller.start();
      const release = h.hold();
      const first = h.puller.pullNow();
      assert.equal(h.puller.state().phase, 'pulling');
      assert.equal(h.puller.state().nextPull, null);
      const second = h.puller.pullNow();
      assert.equal(h.timers.size, 0);
      release();
      await Promise.all([first, second]);
      assert.equal(h.requests.length, 2 * N);
      assert.equal(h.puller.state().phase, 'idle');
      await h.puller.stop();
    });

    it('maps the results: 401/403 on every endpoint = refused', async () => {
      const h = harness({ uexKey: 'bad' });
      h.serve(() => ({ status: 401 }));
      await h.puller.start();
      assert.equal(h.puller.state().last?.outcome, 'refused');
      h.serve((e) => ({ status: e === 'terminals' ? 401 : 403 }));
      await h.puller.pullNow();
      assert.equal(h.puller.state().last?.outcome, 'refused');
      assert.equal(h.maintained(), 0);
      assert.equal(h.puller.state().phase, 'idle');
      assert.equal(h.timers.size, 1);
      await h.puller.stop();
    });

    it('maps the results: no answer = offline; anything else = failed (nothing stored by failed endpoints)', async () => {
      const h = harness({ uexKey: 'k' });
      h.serve(() => ({ throws: true }));
      await h.puller.start();
      assert.equal(h.puller.state().last?.outcome, 'offline');
      h.serve(() => ({ status: 500 }));
      await h.puller.pullNow();
      assert.equal(h.puller.state().last?.outcome, 'failed');
      // Some endpoints refused, some fine: failed, and what arrived is stored and maintained
      h.serve((e) => (e === 'terminals' ? { status: 401 } : { rows: [{ id: 9 }] }));
      await h.puller.pullNow();
      assert.deepEqual([h.puller.state().last?.outcome, h.puller.state().last?.changed], ['failed', N - 1]);
      assert.equal(h.maintained(), 1);
      // One endpoint without an answer, another with 500
      h.serve((e) => (e === 'terminals' ? { throws: true } : e === 'commodities' ? { status: 500 } : { rows: [{ id: 9 }] }));
      await h.puller.pullNow();
      assert.equal(h.puller.state().last?.outcome, 'failed');
      assert.equal(h.logs.some((l) => l.includes('Bearer') || l.includes('"k"')), false);
      await h.puller.stop();
    });

    it('a key set later pulls at once; a changed key pulls with the new one', async () => {
      const h = harness();
      await h.puller.start();
      assert.equal(h.puller.state().phase, 'off');
      h.settings.uexKey = 'one';
      const done = h.puller.reconfigure();
      assert.equal(h.puller.state().phase, 'pulling');
      await done;
      assert.ok(h.requests.every((r) => r.auth === 'Bearer one'));
      assert.equal(h.puller.state().phase, 'idle');
      // Unchanged settings: nothing
      await h.puller.reconfigure();
      assert.equal(h.requests.length, N);
      h.settings.uexKey = 'two';
      await h.puller.reconfigure();
      assert.equal(h.requests.length, 2 * N);
      assert.ok(h.requests.slice(N).every((r) => r.auth === 'Bearer two'));
      assert.equal(h.timers.size, 1);
      await h.puller.stop();
    });

    it('a changed key while a pull runs: the old pull is aborted and a new one runs with the new key', async () => {
      const h = harness({ uexKey: 'old' });
      const release = h.hold();
      const started = h.puller.start();
      await new Promise((r) => setTimeout(r, 10));
      h.settings.uexKey = 'new';
      void h.puller.reconfigure();
      release();
      await started;
      await new Promise((r) => setTimeout(r, 50));
      await h.puller.pullNow();
      assert.ok(h.requests.some((r) => r.auth === 'Bearer new'));
      assert.equal(h.puller.state().phase, 'idle');
      assert.equal(h.puller.state().last?.outcome, 'ok');
      await h.puller.stop();
    });

    it('a removed key: off at once, timer cleared, nothing more is requested', async () => {
      const h = harness({ uexKey: 'k' });
      await h.puller.start();
      assert.equal(h.timers.size, 1);
      h.settings.uexKey = null;
      await h.puller.reconfigure();
      assert.deepEqual([h.puller.state().phase, h.puller.state().nextPull, h.timers.size], ['off', null, 0]);
      await h.puller.pullNow();
      assert.equal(h.requests.length, N);
      await h.puller.stop();
    });

    it('a key removed during a pull: the pull is aborted, its result is dropped, the state stays off', async () => {
      const h = harness({ uexKey: 'k' });
      h.hold();
      const started = h.puller.start();
      await new Promise((r) => setTimeout(r, 10));
      h.settings.uexKey = null;
      await h.puller.reconfigure();
      assert.equal(h.puller.state().phase, 'off');
      await started;
      assert.deepEqual(h.puller.state(), { phase: 'off', lastPull: null, nextPull: null, last: null });
      assert.equal(h.timers.size, 0);
      await h.puller.stop();
    });

    it('a changed interval restarts the wait', async () => {
      const h = harness({ uexKey: 'k' });
      await h.puller.start();
      h.advance(60_000);
      h.settings.uexIntervalMinutes = 60;
      await h.puller.reconfigure();
      assert.deepEqual([...h.timers.values()].map((t) => t.ms), [60 * 60_000]);
      assert.equal(h.puller.state().nextPull, new Date(T0 + 60_000 + 60 * 60_000).toISOString());
      assert.equal(h.requests.length, N);
      await h.puller.stop();
    });

    it('stop: timer cleared, a running pull aborted and awaited, later calls do nothing', async () => {
      const h = harness({ uexKey: 'k' });
      await h.puller.start();
      await h.puller.stop();
      assert.equal(h.timers.size, 0);
      await h.puller.pullNow();
      assert.equal(h.requests.length, N);
      const g = harness({ uexKey: 'k' });
      g.hold();
      const started = g.puller.start();
      await new Promise((r) => setTimeout(r, 10));
      await g.puller.stop();
      await started;
      assert.equal(g.timers.size, 0);
      assert.equal(g.puller.state().last?.outcome, 'offline');
    });
  });

  describe('the routes', () => {
    function routes(h: ReturnType<typeof harness>) {
      const api = new Hono() as unknown as ApiApp;
      mountUexRoutes(h.puller)(api);
      const call = async (method: string, path = '/local/uex') => {
        const res = await api.request(path, { method, headers: { 'content-type': 'application/json' }, body: method === 'POST' ? '{}' : undefined });
        return { status: res.status, body: (await res.json()) as UexState & { error?: string } };
      };
      return call;
    }

    it('GET answers the state; POST pull starts a pull and answers at once; without a key it is 409 noKey', async () => {
      const h = harness();
      const call = routes(h);
      await h.puller.start();
      assert.deepEqual(await call('GET'), { status: 200, body: { phase: 'off', lastPull: null, nextPull: null, last: null } });
      assert.deepEqual(await call('POST', '/local/uex/pull'), { status: 409, body: { error: 'noKey' } });
      assert.equal(h.requests.length, 0);

      h.settings.uexKey = 'k';
      const release = h.hold();
      void h.puller.reconfigure();
      release();
      await new Promise((r) => setTimeout(r, 50));
      const release2 = h.hold();
      const post = await call('POST', '/local/uex/pull');
      assert.equal(post.status, 200);
      assert.equal(post.body.phase, 'pulling');
      release2();
      await h.puller.pullNow();
      const after = await call('GET');
      assert.equal(after.body.phase, 'idle');
      assert.equal(after.body.last?.outcome, 'ok');
      await h.puller.stop();
    });
  });

  describe('capabilities, /api/me and the game version', () => {
    const ORIGIN = 'http://127.0.0.1:3002';
    const caps = async (app: ReturnType<typeof createApp>) => (await (await app.request('/api/capabilities')).json()) as Capabilities;

    it('singleuser: uex follows the key at runtime, without a restart', async () => {
      const settings = { uexKey: null as string | null };
      const app = createApp(webDb, await localIdentity(webDb), {
        origin: ORIGIN, trustProxy: false, distDir: null,
        capabilities: () => ({ login: 'none', orgs: false, uex: settings.uexKey !== null }),
      });
      assert.equal((await caps(app)).uex, false);
      settings.uexKey = 'k';
      assert.equal((await caps(app)).uex, true);
      settings.uexKey = null;
      assert.deepEqual(await caps(app), { login: 'none', orgs: false, uex: false, game: null, companionApi: { min: COMPANION_API_MIN, max: COMPANION_API } });
      // The trade routes stay mounted without data: they answer, empty
      assert.equal((await app.request('/api/trade/items')).status, 200);
    });

    it('online: a static value is served as before, orgs are read once', async () => {
      let orgs = true;
      const value = { login: 'discord' as const, orgs, uex: true };
      const app = createApp(webDb, await localIdentity(webDb), { origin: ORIGIN, trustProxy: false, distDir: null, capabilities: value });
      assert.deepEqual(await caps(app), { login: 'discord', orgs: true, uex: true, game: null, companionApi: { min: COMPANION_API_MIN, max: COMPANION_API } });
      const changing = createApp(webDb, await localIdentity(webDb), {
        origin: ORIGIN, trustProxy: false, distDir: null, capabilities: () => ({ login: 'none', orgs, uex: false }),
      });
      const orgRoute = () => changing.request('/api/orgs/700000000000000071/members');
      assert.equal((await orgRoute()).status, 403);
      orgs = false;
      // The org routes were mounted for the value at build time and stay; only the answer follows
      assert.equal((await caps(changing)).orgs, false);
      assert.equal((await orgRoute()).status, 403);
    });

    it('the game version: null without a catalog; after an import it shows within the cache time, without a restart', async () => {
      mock.timers.enable({ apis: ['Date'], now: T0 });
      try {
        const app = createApp(webDb, await localIdentity(webDb), {
          origin: ORIGIN, trustProxy: false, distDir: null, capabilities: { login: 'none', orgs: false, uex: false },
        });
        assert.equal((await caps(app)).game, null);
        const snap = fixtureSnapshot();
        snap.game.label = '4.10.2.12913470';
        snap.game.build = 12913470;
        await runImport(db, snap, sha256(stableStringify(snap)), { dryRun: false, force: false, allowDowngrade: false, maxRetireRatio: 0.1, maxChangeRatio: 0.5 });
        // Cached: not a query per request
        assert.equal((await caps(app)).game, null);
        mock.timers.tick(6_000);
        assert.deepEqual((await caps(app)).game, { label: '4.10.2.12913470', build: 12913470 });
      } finally {
        mock.timers.reset();
      }
    });

    it('/api/me: the local user has no name and no avatar', async () => {
      const app = createApp(webDb, await localIdentity(webDb), { origin: ORIGIN, trustProxy: false, distDir: null, capabilities: { login: 'none', orgs: false, uex: false } });
      const me = (await (await app.request('/api/me')).json()) as MeResponse;
      assert.deepEqual([me.name, me.username, me.avatarUrl], [null, null, null]);
      assert.equal(me.userId, '00000000000000000');
    });
  });
});
