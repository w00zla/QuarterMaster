// The PGlite connection (src/db/pglite.ts) on its own: no Postgres needed.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { sql } from 'drizzle-orm';
import { connectUrl } from '../src/db/connect-url.ts';
import { connectPglite } from '../src/db/pglite.ts';

describe('PGlite connection', () => {
  const conn = connectPglite(null);
  const { db } = conn;
  before(async () => {
    await db.execute(sql`CREATE TABLE IF NOT EXISTS t (id int PRIMARY KEY, v text)`);
  });
  after(async () => {
    await conn.close();
  });

  it('execute() returns the rows, on the db and inside a transaction', async () => {
    const top = await db.execute<{ n: number }>(sql`SELECT 1 AS n`);
    assert.ok(Array.isArray(top));
    assert.deepEqual(top, [{ n: 1 }]);
    await db.transaction(async (tx) => {
      const inner = await tx.execute<{ n: number }>(sql`SELECT 2 AS n`);
      assert.ok(Array.isArray(inner));
      assert.deepEqual(inner, [{ n: 2 }]);
      // a nested transaction (savepoint) too
      await tx.transaction(async (tx2) => assert.deepEqual(await tx2.execute(sql`SELECT 3 AS n`), [{ n: 3 }]));
    });
  });

  it('the outer db inside a transaction fails at once and names the method', async () => {
    await db.transaction(async (tx) => {
      await tx.execute(sql`INSERT INTO t VALUES (1, 'a')`);
      assert.throws(() => db.execute(sql`SELECT 1`), /db\.execute\(\) was called inside a transaction/);
      assert.throws(() => db.transaction(async () => {}), /db\.transaction\(\)/);
      assert.throws(() => db.select(), /db\.select\(\)/);
      // the transaction still works and commits
      await tx.execute(sql`INSERT INTO t VALUES (2, 'b')`);
    });
    assert.deepEqual(await db.execute(sql`SELECT count(*)::int AS n FROM t`), [{ n: 2 }]);
    // after the transaction the outer db works again
    assert.deepEqual(await db.execute(sql`SELECT 1 AS n`), [{ n: 1 }]);
  });

  it('maintain() runs CHECKPOINT and VACUUM', async () => {
    await conn.maintain();
    assert.deepEqual(await db.execute(sql`SELECT count(*)::int AS n FROM t`), [{ n: 2 }]);
  });

  it('listen() receives a pg_notify and calls onListen once', async () => {
    let listening = 0;
    const heard: string[] = [];
    const sub = await conn.client.listen('qm_test', (p) => heard.push(p), () => listening++);
    await db.execute(sql`SELECT pg_notify('qm_test', 'hello')`);
    for (let i = 0; i < 50 && heard.length === 0; i++) await new Promise((r) => setTimeout(r, 20));
    await sub.unlisten();
    assert.deepEqual(heard, ['hello']);
    assert.equal(listening, 1);
  });

  it('a second connection to the same dir shares the instance', async () => {
    const other = connectPglite(null);
    try {
      assert.deepEqual(await other.db.execute(sql`SELECT count(*)::int AS n FROM t`), [{ n: 2 }]);
    } finally {
      await other.close();
    }
    // closing it did not close the instance of the first
    assert.deepEqual(await db.execute(sql`SELECT 1 AS n`), [{ n: 1 }]);
  });

});

describe('PGlite data dir', () => {
  const dir = mkdtempSync(join(tmpdir(), 'qm-pglite-'));
  after(() => rmSync(dir, { recursive: true, force: true }));

  it('the settings default to the small footprint, an option overrides one by name, and they apply on every open', async () => {
    const show = async (c: ReturnType<typeof connectPglite>, name: string) =>
      (await c.db.execute<{ setting: string }>(sql`SELECT setting FROM pg_settings WHERE name = ${name}`))[0]!.setting;
    const settingsDir = join(dir, 'conf');
    const first = connectPglite(settingsDir, { postgresqlconf: ['max_wal_size=48MB'] });
    try {
      assert.equal(await show(first, 'max_wal_size'), '48');
      assert.equal(await show(first, 'min_wal_size'), '32');
      assert.equal(await show(first, 'shared_buffers'), '2048'); // 16MB in 8kB pages
    } finally {
      await first.close();
    }
    const second = connectPglite(settingsDir);
    try {
      assert.equal(await show(second, 'max_wal_size'), '32'); // the default again: the dir does not keep the override
    } finally {
      await second.close();
    }
  });

  it('survives close and reopen; the last close really closes, an earlier one does not', async () => {
    const a = connectUrl(`pglite:${dir}`);
    const b = connectPglite(dir);
    await a.db.execute(sql`CREATE TABLE keep (v text)`);
    await a.db.execute(sql`INSERT INTO keep VALUES ('still here')`);
    await a.maintain();
    await a.close();
    // b still works: the instance lives until its last user is gone
    assert.deepEqual(await b.db.execute(sql`SELECT v FROM keep`), [{ v: 'still here' }]);
    await b.close();
    await b.close(); // idempotent

    const again = connectPglite(dir);
    try {
      assert.deepEqual(await again.db.execute(sql`SELECT v FROM keep`), [{ v: 'still here' }]);
    } finally {
      await again.close();
    }
  });
});
