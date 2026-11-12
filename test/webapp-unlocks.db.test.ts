// Runs against TEST_DATABASE_URL only; the web, bot, app and catalog schemas there are dropped and recreated.
// The blueprint unlocks through Hono (app.request): the catalog's flag, the info card's summary and the
// details dialog's sections from the fixtures' two sources (a mission and an event tier).
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type { Db } from '../src/db/client.ts';
import { connectAs, prepareDb } from './roles.ts';
import { runImport } from '../src/catalog/import/apply.ts';
import { sha256, stableStringify } from '../src/catalog/import/plan.ts';
import { runLocImport } from '../src/catalog/import/loc-import.ts';
import type { BlueprintInfo, CatalogResponse, UnlocksResponse } from '../src/webapp/api-types.ts';
import { createApp } from '../src/webapp/app.ts';
import type { DiscordLogin } from '../src/webapp/discord.ts';
import { discordIdentity } from '../src/webapp/identity-discord.ts';
import { createSession } from '../src/webapp/session.ts';
import { U, fixtureSnapshot } from './fixtures.ts';

const url = process.env.TEST_DATABASE_URL;
const ORIGIN = 'https://qm.test';
const SOLO = '740000000000000061';
const noLogin: DiscordLogin = { start: () => Promise.reject(new Error('unused')), finish: () => Promise.reject(new Error('unused')) };

describe('web app blueprint unlocks (database)', { skip: url ? false : 'TEST_DATABASE_URL not set' }, () => {
  let db: Db;
  let webDb: Db;
  let closeDb: () => Promise<void>;
  let closeWeb: () => Promise<void>;
  let app: ReturnType<typeof createApp>;
  let token: string;

  const get = async <T>(path: string, auth = true) => {
    const res = await app.request(`/api${path}`, { headers: auth ? { cookie: `__Host-qm_session=${token}`, origin: ORIGIN } : {} });
    return { status: res.status, body: (await res.json()) as T };
  };

  before(async () => {
    await prepareDb(url);
    ({ db, close: closeDb } = connectAs(url, 'qm_app'));
    ({ db: webDb, close: closeWeb } = connectAs(url, 'qm_web'));
    const snap = fixtureSnapshot();
    await runImport(db, snap, sha256(stableStringify(snap)), { dryRun: false, force: false, allowDowngrade: false, maxRetireRatio: 0.1, maxChangeRatio: 0.5 });
    // The fixtures carry no texts for the contract: a community source adds them
    await runLocImport(db, {
      test_mission_title: 'Deliver to ~mission(Location)', test_mission_type: 'Delivery', test_faction: 'Test Faction', test_rank1: 'Rank One',
      teststar: 'Testsun',
    }, { source: 'unlock-test', lang: 'en', priority: null, origin: 'test', dryRun: false, force: true, maxRemoveRatio: 1, minGameOverlap: 0 });
    token = await createSession(webDb, { id: SOLO, username: 'solo', globalName: null, avatar: null });
    app = createApp(webDb, discordIdentity(webDb, noLogin), { origin: ORIGIN, trustProxy: false, distDir: null, capabilities: { login: 'discord', orgs: true, uex: true } });
  });
  after(async () => { await closeDb?.(); await closeWeb?.(); });

  it('catalog: unlockable only for blueprints with a source', async () => {
    const { body } = await get<CatalogResponse>('/catalog?lang=en');
    const flag = new Map(body.blueprints.map((b) => [b.uuid, b.unlockable]));
    assert.equal(flag.get(U.blueprint2), true);
    assert.equal(flag.get(U.blueprint), false);
  });

  it('info card: one line per kind, markers every source has, the best odds', async () => {
    const info = (await get<BlueprintInfo>(`/info/blueprint/${U.blueprint2}?lang=en`)).body;
    assert.deepEqual(info.unlocks, [
      { kind: 'mission', count: 1, markers: ['illegal', 'event', 'chain', 'rank', 'random', 'onAccept'], best: { num: 1, den: 1, chance: 0.5 }, varies: false },
      { kind: 'event', count: 1, markers: [], best: { num: 1, den: 1, chance: null }, varies: false },
    ]);
    assert.deepEqual((await get<BlueprintInfo>(`/info/blueprint/${U.blueprint}?lang=en`)).body.unlocks, []);
  });

  it('details: missions grouped with texts, systems and the bound place; event tiers', async () => {
    const { status, body } = await get<UnlocksResponse>(`/unlocks/${U.blueprint2}?lang=en`);
    assert.equal(status, 200);
    assert.equal(typeof body.name, 'string');
    assert.deepEqual(body.sections, [
      {
        kind: 'mission', count: 1, groups: [{
          faction: 'Test Faction', missionType: 'Delivery', count: 1, systems: ['Testsun'], rankFrom: 'Rank One', rankTo: 'Rank One',
          best: { num: 1, den: 1, chance: 0.5 }, varies: false,
          rows: [{
            title: 'Deliver to …', rank: 'Rank One', systems: ['Testsun'], locations: ['Test Station'], markers: ['illegal', 'chain', 'onAccept'],
            event: 'Test', odds: { num: 1, den: 1, chance: 0.5 }, count: 1,
          }],
        }],
      },
      { kind: 'event', count: 1, tiers: [{ event: 'TestEvent', minPoints: 1000, odds: { num: 1, den: 1, chance: null }, count: 1 }] },
    ]);
    // Without a source: no sections; German falls back to the English texts
    assert.deepEqual((await get<UnlocksResponse>(`/unlocks/${U.blueprint}?lang=en`)).body.sections, []);
    assert.equal((await get<UnlocksResponse>(`/unlocks/${U.blueprint2}?lang=de`)).body.sections.length, 2);
  });

  it('refuses malformed or unknown blueprints and requests without a session', async () => {
    assert.equal((await get('/unlocks/nope')).status, 400);
    assert.equal((await get('/unlocks/10000000-0000-0000-0000-0000000000aa')).status, 404);
    assert.equal((await get(`/unlocks/${U.blueprint2}`, false)).status, 401);
  });
});
