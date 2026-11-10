// Smoke test of the singleuser entry point as a real child process on a temp data folder and a port outside the
// product range. Needs no Postgres. Every wait has a hard limit; the child is killed in `finally`.
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { runImport } from '../src/catalog/import/apply.ts';
import { sha256, stableStringify } from '../src/catalog/import/plan.ts';
import { buildRelease, gzipStable } from '../src/datapack/build.ts';
import { connectPglite } from '../src/db/pglite.ts';
import { dbDir } from '../src/singleuser/paths.ts';
import type { Capabilities, DataUpdateState, MeResponse, StockListResponse } from '../src/webapp/api-types.ts';
import { LOCAL_USER_ID } from '../src/webapp/identity-local.ts';
import { U, fixtureSnapshot } from './fixtures.ts';

const ROOT = new URL('../', import.meta.url);
const RUNNER = fileURLToPath(new URL('test/singleuser-runner.mjs', ROOT));
const MAIN = fileURLToPath(new URL('src/singleuser/main.ts', ROOT));
const JSON_TYPE = { 'content-type': 'application/json' };

const freePort = () => new Promise<number>((resolve, reject) => {
  const probe = createServer();
  probe.once('error', reject);
  probe.listen(0, '127.0.0.1', () => {
    const { port } = probe.address() as { port: number };
    probe.close(() => resolve(port));
  });
});

type Child = { proc: ChildProcess; out: () => string; exited: Promise<number | null> };
function start(script: string, env: Record<string, string>): Child {
  const proc = spawn(process.execPath, [script], { env: { ...process.env, DATABASE_URL: '', ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
  let text = '';
  proc.stdout!.on('data', (d: Buffer) => (text += d));
  proc.stderr!.on('data', (d: Buffer) => (text += d));
  const exited = new Promise<number | null>((resolve) => proc.once('exit', (code) => resolve(code)));
  return { proc, out: () => text, exited };
}
const within = <T>(ms: number, what: string, p: Promise<T>) => new Promise<T>((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(`timeout after ${ms} ms: ${what}`)), ms);
  p.then((v) => { clearTimeout(timer); resolve(v); }, (e: unknown) => { clearTimeout(timer); reject(e as Error); });
});
const until = async (ms: number, what: string, done: () => boolean) => {
  const end = Date.now() + ms;
  while (!done()) {
    if (Date.now() > end) throw new Error(`timeout after ${ms} ms: ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
};
/** A request with a Host header of our choice (fetch cannot set it). */
const withHost = (port: number, host: string) => new Promise<number>((resolve, reject) => {
  const req = request({ host: '127.0.0.1', port, path: '/api/capabilities', headers: { host }, timeout: 5000 }, (res) => { res.resume(); resolve(res.statusCode ?? 0); });
  req.on('error', reject);
  req.end();
});

describe('singleuser: the process', { timeout: 120_000 }, () => {
  it('starts, serves the fixed user, takes a write, refuses a second start, ends on request', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'qm-singleuser-'));
    const port = await freePort();
    // QM_AUTO_UPDATE=0: no feed is asked (this test must not touch the network)
    const env = { QM_DATA_DIR: dir, QM_PORT: String(port), QM_THUMBS_DIR: join(dir, 'no-thumbs'), QM_AUTO_UPDATE: '0' };
    const base = `http://127.0.0.1:${port}`;
    let child: Child | undefined;
    try {
      // The catalog the write refers to: imported before the server owns the folder
      const seed = connectPglite(dbDir(dir));
      try {
        await seed.migrate(fileURLToPath(new URL('drizzle', ROOT)));
        const snap = fixtureSnapshot();
        await runImport(seed.db, snap, sha256(stableStringify(snap)), { dryRun: false, force: false, allowDowngrade: false, maxRetireRatio: 0.1, maxChangeRatio: 0.5 });
      } finally {
        await seed.close();
      }

      child = start(RUNNER, env);
      const c = child;
      await until(60_000, `"listening" line, output: ${c.out()}`, () => /listening on /.test(c.out()) || c.proc.exitCode !== null);
      assert.match(c.out(), new RegExp(`listening on ${base}`));
      for (const step of ['open database', 'migrations', 'checkpoint', 'listen']) assert.match(c.out(), new RegExp(`${step}: \\d+ ms`));

      const json = async <T>(path: string, init: RequestInit = {}) => {
        const res = await fetch(`${base}${path}`, { ...init, signal: AbortSignal.timeout(10_000) });
        return { status: res.status, body: (await res.json()) as T };
      };
      assert.deepEqual(await json<Capabilities>('/api/capabilities'), { status: 200, body: { login: 'none', orgs: false, uex: false } });
      // The data update is off: nothing installed, nothing asked
      assert.deepEqual(await json<DataUpdateState>('/api/local/data'), { status: 200, body: { phase: 'idle', installed: null, progress: null, last: null } });
      const me = await json<MeResponse>('/api/me');
      assert.equal(me.status, 200);
      assert.equal(me.body.userId, LOCAL_USER_ID);
      const add = await json('/api/stock/add', { method: 'POST', headers: JSON_TYPE, body: JSON.stringify({ subjectUuid: U.metal, locationUuid: U.station, quality: 640, amount: '3' }) });
      assert.deepEqual(add, { status: 200, body: { ok: true } });
      const stock = await json<StockListResponse>('/api/stock?scope=personal');
      assert.equal(stock.body.batches.filter((b) => b.quality === 640 && b.quantity === '3').length, 1);

      // The Host guard in the real process
      assert.equal(await withHost(port, `localhost:${port}`), 200);
      assert.equal(await withHost(port, `evil.example:${port}`), 421);

      // A second start on the same port fails clearly, without touching the database
      const second = start(MAIN, env);
      try {
        assert.equal(await within(30_000, 'second start exits', second.exited), 1);
        assert.match(second.out(), /Start failed: Port \d+ \(QM_PORT\) is already in use/);
      } finally {
        second.proc.kill();
      }
      assert.equal((await json<Capabilities>('/api/capabilities')).status, 200);

      // Stop: the shutdown handler, then the process is gone within seconds
      const stopped = Date.now();
      c.proc.stdin!.write('stop\n');
      assert.equal(await within(8_000, 'the process ends', c.exited), 0);
      assert.ok(Date.now() - stopped < 8_000);
      assert.match(c.out(), /stopped/);
    } finally {
      child?.proc.kill();
      await new Promise((r) => setTimeout(r, 200));
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
  });

  it('updates itself from a feed folder: first install at start, then a chain on request; serves the catalog and a picture', async () => {
    const root = mkdtempSync(join(tmpdir(), 'qm-singleuser-feed-'));
    const dir = join(root, 'data');
    const feed = join(root, 'feed');
    const port = await freePort();
    const base = `http://127.0.0.1:${port}`;
    const env = { QM_DATA_DIR: dir, QM_PORT: String(port), QM_DATA_FEED: feed };
    let child: Child | undefined;
    try {
      // Two releases of the fixtures' catalog; release 2 adds one picture
      const uuid = (i: number) => `20000000-0000-0000-0000-${i.toString(16).padStart(12, '0')}`;
      const snapshot = fixtureSnapshot();
      snapshot.game.label = '1.0.1000';
      const snapshotFile = join(root, 'snapshot.json.gz');
      writeFileSync(snapshotFile, gzipStable(Buffer.from(JSON.stringify(snapshot))));
      const thumbs = (items: number[]) => {
        const out = join(root, `thumbs-${items.length}`);
        const index: Record<string, string> = {};
        for (const i of items) {
          index[uuid(i)] = 'aaaaaaaa';
          for (const size of ['s', 'm', 'l']) {
            mkdirSync(join(out, size), { recursive: true });
            writeFileSync(join(out, size, `${uuid(i)}.aaaaaaaa.avif`), `fake ${size} ${i}`);
          }
        }
        writeFileSync(join(out, 'thumbs.json'), JSON.stringify(index));
        return out;
      };
      buildRelease({ snapshotFile, thumbsDir: thumbs([1]), n: 1, outDir: join(feed, 'data-1.0.1000-1') });
      buildRelease({ snapshotFile, thumbsDir: thumbs([1, 2]), n: 2, previousDir: join(feed, 'data-1.0.1000-1'), outDir: join(feed, 'data-1.0.1000-2') });
      const channel = (n: number) => writeFileSync(join(feed, 'channels.json'), JSON.stringify({ data: { stable: `data-1.0.1000-${n}` } }));
      channel(1);

      child = start(RUNNER, env);
      const c = child;
      await until(60_000, `"listening" line, output: ${c.out()}`, () => /listening on /.test(c.out()) || c.proc.exitCode !== null);
      const state = async () => (await (await fetch(`${base}/api/local/data`, { signal: AbortSignal.timeout(10_000) })).json()) as DataUpdateState;
      // Polls the state endpoint (it answers while an install holds the database)
      const installed = async (tag: string) => {
        const end = Date.now() + 60_000;
        for (;;) {
          const s = await state();
          if (s.installed?.tag === tag && s.phase === 'idle') return s;
          if (Date.now() > end) throw new Error(`timeout: installed ${tag}, state ${JSON.stringify(s)}, output: ${c.out()}`);
          await new Promise((r) => setTimeout(r, 100));
        }
      };
      await installed('data-1.0.1000-1');
      assert.match(c.out(), /data update: plan full \(nothingInstalled\)/);

      const catalog = (await (await fetch(`${base}/api/catalog`, { signal: AbortSignal.timeout(10_000) })).json()) as { materials: unknown[] };
      assert.ok(catalog.materials.length > 0);
      assert.equal((await fetch(`${base}/thumbs/s/${uuid(1)}.aaaaaaaa.avif`, { signal: AbortSignal.timeout(10_000) })).status, 200);
      assert.equal((await fetch(`${base}/thumbs/s/${uuid(2)}.aaaaaaaa.avif`, { signal: AbortSignal.timeout(10_000) })).status, 404);

      // The feed moves on; the check is asked for (JSON only, like every write) and answers at once
      channel(2);
      const res = await fetch(`${base}/api/local/data/check`, { method: 'POST', headers: JSON_TYPE, body: '{}', signal: AbortSignal.timeout(10_000) });
      assert.equal(res.status, 200);
      assert.ok(['checking', 'downloading', 'installing', 'idle'].includes(((await res.json()) as DataUpdateState).phase));
      await installed('data-1.0.1000-2');
      assert.match(c.out(), /data update: plan chain/);
      // The server re-reads thumbs.json at most every 10 s (src/thumbs-index.ts): the new picture shows up within that
      const end = Date.now() + 25_000;
      let status = 0;
      while (status !== 200 && Date.now() < end) {
        status = (await fetch(`${base}/thumbs/s/${uuid(2)}.aaaaaaaa.avif`, { signal: AbortSignal.timeout(10_000) })).status;
        if (status !== 200) await new Promise((r) => setTimeout(r, 500));
      }
      assert.equal(status, 200);

      c.proc.stdin!.write('stop\n');
      assert.equal(await within(8_000, 'the process ends', c.exited), 0);
      assert.equal(existsSync(join(dir, 'downloads')), false);
    } finally {
      child?.proc.kill();
      await new Promise((r) => setTimeout(r, 200));
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
  });
});
