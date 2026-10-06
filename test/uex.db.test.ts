// Runs against TEST_DATABASE_URL only; the uex, web, bot, app and catalog schemas there are dropped and recreated.
// The UEX pull with the API replaced by a fake fetch.
import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import { asc, sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { connect, type Db } from '../src/db/client.ts';
import { snapshot } from '../src/db/schema/uex.ts';
import { fetchEndpoint, pullAll, storeSnapshot } from '../src/uex/fetch.ts';

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
    ({ db, close } = connect(url));
    for (const schema of ['uex', 'web', 'bot', 'app', 'catalog', 'drizzle']) await db.execute(sql.raw(`DROP SCHEMA IF EXISTS ${schema} CASCADE`));
    await migrate(db, { migrationsFolder: new URL('../drizzle', import.meta.url).pathname });
  });
  after(() => close());
  beforeEach(() => db.execute(sql`TRUNCATE uex.snapshot`));

  const rows = () => db.select().from(snapshot).orderBy(asc(snapshot.id));

  it('stores a snapshot only when the content changed', async () => {
    assert.equal(await storeSnapshot(db, 'refineries_yields', [{ id: 1, value: 5 }]), 'inserted');
    const [first] = await rows();
    assert.equal(await storeSnapshot(db, 'refineries_yields', [{ id: 1, value: 5 }]), 'unchanged');
    let all = await rows();
    assert.equal(all.length, 1);
    assert.ok(all[0]!.checkedAt > first!.checkedAt);
    assert.equal(all[0]!.fetchedAt.getTime(), first!.fetchedAt.getTime());

    assert.equal(await storeSnapshot(db, 'refineries_yields', [{ id: 1, value: 6 }]), 'inserted');
    // Back to the first content: a new row, the history shows the flip
    assert.equal(await storeSnapshot(db, 'refineries_yields', [{ id: 1, value: 5 }]), 'inserted');
    // Another endpoint is compared with its own latest row only
    assert.equal(await storeSnapshot(db, 'refineries_methods', [{ id: 1, value: 5 }]), 'inserted');
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
      await pullAll(db, 'tok', fetchFn);
    } finally {
      console.error = error;
    }
    assert.deepEqual((await rows()).map((r) => r.endpoint), ['refineries_methods']);
  });
});
