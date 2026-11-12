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
    assert.equal(await storeSnapshot(db, 'uex', 'terminals', [{ id: 1, value: 5 }]), 'inserted');
    const [first] = await rows();
    assert.equal(await storeSnapshot(db, 'uex', 'terminals', [{ id: 1, value: 5 }]), 'unchanged');
    let all = await rows();
    assert.equal(all.length, 1);
    assert.ok(all[0]!.checkedAt > first!.checkedAt);
    assert.equal(all[0]!.fetchedAt.getTime(), first!.fetchedAt.getTime());

    assert.equal(await storeSnapshot(db, 'uex', 'terminals', [{ id: 1, value: 6 }]), 'inserted');
    // Back to the first content: a new row, the history shows the flip
    assert.equal(await storeSnapshot(db, 'uex', 'terminals', [{ id: 1, value: 5 }]), 'inserted');
    // Another endpoint is compared with its own latest row only
    assert.equal(await storeSnapshot(db, 'uex', 'commodities', [{ id: 1, value: 5 }]), 'inserted');
    all = await rows();
    assert.deepEqual(all.map((r) => [r.endpoint, r.data]), [
      ['terminals', [{ id: 1, value: 5 }]],
      ['terminals', [{ id: 1, value: 6 }]],
      ['terminals', [{ id: 1, value: 5 }]],
      ['commodities', [{ id: 1, value: 5 }]],
    ]);
  });

  it('keeps only the latest snapshot of a latest-only endpoint', async () => {
    await storeSnapshot(db, 'uex', 'items_prices_all', [{ id: 1, price_buy: 10 }], true);
    await storeSnapshot(db, 'uex', 'terminals', [{ id: 1, value: 5 }]);
    assert.equal(await storeSnapshot(db, 'uex', 'items_prices_all', [{ id: 1, price_buy: 10 }], true), 'unchanged');
    assert.equal(await storeSnapshot(db, 'uex', 'items_prices_all', [{ id: 1, price_buy: 12 }], true), 'inserted');
    // Other endpoints keep their rows
    assert.deepEqual((await rows()).map((r) => [r.endpoint, r.data]), [
      ['terminals', [{ id: 1, value: 5 }]],
      ['items_prices_all', [{ id: 1, price_buy: 12 }]],
    ]);
  });

  it('sends the token and refuses error answers and foreign shapes', async () => {
    const { fetchFn, seen } = fakeUex({
      terminals: ok([{ id: 1 }]),
      commodities: { status: 403, body: { status: 'access_denied', http_code: 403, data: null, message: 'Invalid bearer token.' } },
      odd: { body: { status: 'ok', data: 'nope' } },
    });
    assert.deepEqual(await fetchEndpoint('terminals', 'tok', fetchFn), [{ id: 1 }]);
    assert.equal(seen[0], 'Bearer tok');
    await assert.rejects(fetchEndpoint('commodities', 'tok', fetchFn), /HTTP 403/);
    await assert.rejects(fetchEndpoint('odd', 'tok', fetchFn), /unexpected response/);
  });

  it('pulls every endpoint, a failing one does not stop the others', async () => {
    const { fetchFn } = fakeUex({
      terminals: { status: 500, body: 'boom' },
      commodities: ok([{ id: 1, name: 'Iron' }]),
    });
    const error = console.error;
    console.error = () => {};
    try {
      await pullUex(db, 'tok', fetchFn);
    } finally {
      console.error = error;
    }
    assert.deepEqual((await rows()).map((r) => r.endpoint), ['commodities']);
  });

  it('answers the admin overview: the status per endpoint', async () => {
    assert.deepEqual([...(await getUex(db)).endpoints], []);
    await storeSnapshot(db, 'uex', 'terminals', [{ id: 1 }]);
    await storeSnapshot(db, 'uex', 'terminals', [{ id: 1 }, { id: 2 }]);
    await storeSnapshot(db, 'uex', 'commodities', [{ id: 1, name: 'Iron' }]);
    assert.deepEqual((await getUex(db)).endpoints.map((e) => [e.endpoint, e.rows, e.snapshots]), [['commodities', 1, 1], ['terminals', 2, 2]]);
  });
});
