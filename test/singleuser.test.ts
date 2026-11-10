// Smoke test of the singleuser entry point as a real child process on a temp data folder and a port outside the
// product range. Needs no Postgres. Every wait has a hard limit; the child is killed in `finally`.
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { request } from 'node:http';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { runImport } from '../src/catalog/import/apply.ts';
import { sha256, stableStringify } from '../src/catalog/import/plan.ts';
import { connectPglite } from '../src/db/pglite.ts';
import { dbDir } from '../src/singleuser/paths.ts';
import type { Capabilities, MeResponse, StockListResponse } from '../src/webapp/api-types.ts';
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
    const env = { QM_DATA_DIR: dir, QM_PORT: String(port), QM_THUMBS_DIR: join(dir, 'no-thumbs') };
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
});
