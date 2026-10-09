// Runs against TEST_DATABASE_URL only; the ext, web, bot, app and catalog schemas there are dropped and recreated.
// The UEX pull with the API replaced by a fake fetch.
import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import { asc, sql } from 'drizzle-orm';
import { type Db } from '../src/db/client.ts';
import { connectAs, prepareDb } from './roles.ts';
import { snapshot } from '../src/db/schema/ext.ts';
import { storeSnapshot } from '../src/ext/store.ts';
import { fetchEndpoint, pullUex } from '../src/ext/uex.ts';
import { getUex } from '../src/adminapp/queries.ts';

const url = process.env.TEST_DATABASE_URL;

/** Fake UEX: answers each endpoint from `bodies`, records the auth header. */
function fakeUex(bodies: Record<string, { status?: number; body: unknown }>) {
  const seen: string[] = [];
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    seen.push(new Headers(init?.headers).get('authorization') ?? '');
    const endpoint = String(input).split('/').at(-2) ?? '';
    const answer = bodies[endpoint];
    if (!answer) return new Response('not found', { status: 404 });
    return new Response(JSON.stringify(answer.body), { status: answer.status ?? 200 });
  }) as typeof fetch;
  return { fetchFn, seen };
}

const ok = (data: unknown[]) => ({ body: { status: 'ok', http_code: 200, data, message: '' } });

describe('UEX pull', { skip: !url && 'TEST_DATABASE_URL not set' }, () => {
  let db: Db;
  let close: () => Promise<void>;

  before(async () => {
    await prepareDb(url);
    ({ db, close } = connectAs(url, 'qm_app'));
  });
  after(() => close());
  beforeEach(() => db.execute(sql`DELETE FROM ext.snapshot`));

  const rows = () => db.select().from(snapshot).orderBy(asc(snapshot.id));

  it('stores a snapshot only when the content changed', async () => {
    assert.equal(await storeSnapshot(db, 'uex', 'refineries_yields', [{ id: 1, value: 5 }]), 'inserted');
    const [first] = await rows();
    assert.equal(await storeSnapshot(db, 'uex', 'refineries_yields', [{ id: 1, value: 5 }]), 'unchanged');
    let all = await rows();
    assert.equal(all.length, 1);
    assert.ok(all[0]!.checkedAt > first!.checkedAt);
    assert.equal(all[0]!.fetchedAt.getTime(), first!.fetchedAt.getTime());

    assert.equal(await storeSnapshot(db, 'uex', 'refineries_yields', [{ id: 1, value: 6 }]), 'inserted');
    // Back to the first content: a new row, the history shows the flip
    assert.equal(await storeSnapshot(db, 'uex', 'refineries_yields', [{ id: 1, value: 5 }]), 'inserted');
    // Another endpoint is compared with its own latest row only
    assert.equal(await storeSnapshot(db, 'uex', 'refineries_methods', [{ id: 1, value: 5 }]), 'inserted');
    all = await rows();
    assert.deepEqual(all.map((r) => [r.endpoint, r.data]), [
      ['refineries_yields', [{ id: 1, value: 5 }]],
      ['refineries_yields', [{ id: 1, value: 6 }]],
      ['refineries_yields', [{ id: 1, value: 5 }]],
      ['refineries_methods', [{ id: 1, value: 5 }]],
    ]);
  });

  it('sends the token and refuses error answers and foreign shapes', async () => {
    const { fetchFn, seen } = fakeUex({
      refineries_yields: ok([{ id: 1 }]),
      refineries_methods: { status: 403, body: { status: 'access_denied', http_code: 403, data: null, message: 'Invalid bearer token.' } },
      odd: { body: { status: 'ok', data: 'nope' } },
    });
    assert.deepEqual(await fetchEndpoint('refineries_yields', 'tok', fetchFn), [{ id: 1 }]);
    assert.equal(seen[0], 'Bearer tok');
    await assert.rejects(fetchEndpoint('refineries_methods', 'tok', fetchFn), /HTTP 403/);
    await assert.rejects(fetchEndpoint('odd', 'tok', fetchFn), /unexpected response/);
  });

  it('pulls every endpoint, a failing one does not stop the others', async () => {
    const { fetchFn } = fakeUex({
      refineries_yields: { status: 500, body: 'boom' },
      refineries_methods: ok([{ id: 1, name: 'Cormack' }]),
    });
    const error = console.error;
    console.error = () => {};
    try {
      await pullUex(db, 'tok', fetchFn);
    } finally {
      console.error = error;
    }
    assert.deepEqual((await rows()).map((r) => r.endpoint), ['refineries_methods']);
  });

  it('answers the admin overview: status, terminals with their yields, methods', async () => {
    const empty = await getUex(db, 'en');
    assert.deepEqual([[...empty.endpoints], empty.refineries, empty.ores, empty.methods.length], [[], [], [], 9]);
    const y = (terminal: number, place: string, ore: string, value: number) =>
      ({ id_terminal: terminal, terminal_name: `Refinery ${place}`, star_system_name: 'Nyx', space_station_name: place, commodity_name: ore, value });
    await storeSnapshot(db, 'uex', 'refineries_yields', [y(1, 'Old', 'Iron (Ore)', 1)]);
    await storeSnapshot(db, 'uex', 'refineries_yields', [y(2, 'Zeta', 'Iron (Ore)', -5), y(1, 'Alpha', 'Gold (Ore)', 8), y(1, 'Alpha', 'Iron (Ore)', 2)]);
    await storeSnapshot(db, 'uex', 'refineries_methods', [{ id: 1, name: 'Cormack', code: 'COR', rating_yield: 1, rating_cost: 2, rating_speed: 3 }]);
    const uex = await getUex(db, 'en');
    assert.deepEqual(uex.endpoints.map((e) => [e.endpoint, e.rows, e.snapshots]), [['refineries_methods', 1, 1], ['refineries_yields', 3, 2]]);
    assert.deepEqual(uex.ores, ['Gold (Ore)', 'Iron (Ore)']);
    assert.deepEqual(uex.refineries.map((r) => [r.place, r.location, r.yields]), [
      ['Alpha', null, { 'Gold (Ore)': 8, 'Iron (Ore)': 2 }], ['Zeta', null, { 'Iron (Ore)': -5 }],
    ]);
    // The method values (measured, migration 0015), with UEX's ratings joined by code
    assert.equal(uex.methods.length, 9);
    assert.deepEqual(uex.methods[0]!.code, 'DIN');
    assert.deepEqual(uex.methods.find((m) => m.code === 'COR'), {
      name: 'COR', code: 'COR', ratingYield: 1, ratingCost: 2, ratingSpeed: 3, yieldPct: 31.5, secondsPerScu: 16, source: 'in-game quotes CRU-L1 · 4.10.1',
    });
  });
});
