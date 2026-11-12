// The app bundle (src/singleuser/app-bundle.ts): built into a temp folder, copied to another place without node_modules, started
// with a temp data folder and a test port, and asked for the capabilities, the SPA's index and one static asset. No Postgres,
// no network. Every wait has a hard limit; the child is killed in `finally`.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { buildBundle, NODE_FLAGS, NODE_VERSION, PGLITE_FILES, startTexts } from '../src/singleuser/app-bundle.ts';

const freePort = () => new Promise<number>((resolve, reject) => {
  const probe = createServer();
  probe.once('error', reject);
  probe.listen(0, '127.0.0.1', () => {
    const { port } = probe.address() as { port: number };
    probe.close(() => resolve(port));
  });
});

describe('app bundle', { timeout: 240_000 }, () => {
  it('is one folder that runs from anywhere with a bare node: protocol, capabilities, the SPA and an asset', async () => {
    const work = mkdtempSync(join(tmpdir(), 'qm-bundle-'));
    let proc: ReturnType<typeof spawn> | undefined;
    try {
      const built = await buildBundle({ out: join(work, 'built') });
      const names = built.files.map((f) => f.path);
      for (const file of ['server.mjs', 'bundle.json', ...PGLITE_FILES, 'web/index.html']) assert.ok(names.includes(file), file);
      assert.ok(names.some((n) => n.startsWith('drizzle/') && n.endsWith('.sql')));
      assert.ok(names.some((n) => n.startsWith('drizzle/meta/')));

      const info = JSON.parse(readFileSync(join(work, 'built', 'bundle.json'), 'utf8')) as {
        app: { version: string }; node: { version: string }; nodeFlags: string[]; startTexts: Record<string, Record<string, string>>; files: Array<{ path: string; size: number }>;
      };
      const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };
      assert.equal(info.app.version, pkg.version);
      assert.equal(info.node.version, NODE_VERSION);
      assert.deepEqual(info.nodeFlags, NODE_FLAGS);
      assert.deepEqual(info.startTexts.en, { starting: 'Starting …', languagePack: 'Loading language pack …' });
      assert.deepEqual(info.startTexts.de, { starting: 'Starte …', languagePack: 'Sprachpaket wird geladen …' });
      // The list names every file with its size (bundle.json itself excepted)
      assert.deepEqual(info.files.map((f) => f.path), names.filter((n) => n !== 'bundle.json'));

      // Somewhere else, under a folder with no node_modules above it
      const elsewhere = join(work, 'elsewhere', 'qm');
      mkdirSync(join(work, 'elsewhere'));
      cpSync(join(work, 'built'), elsewhere, { recursive: true });
      const data = join(work, 'data');
      const port = await freePort();
      const env = {
        ...process.env, DATABASE_URL: '', NODE_OPTIONS: '', QM_DATA_DIR: data, QM_PORT: String(port), QM_AUTO_UPDATE: '0', QM_GAME_DIR: '', QM_UEX_KEY: '',
        QM_PAIRING_FILE: join(work, 'pairing.json'), QM_MIGRATIONS_DIR: join(elsewhere, 'drizzle'), QM_DIST_DIR: join(elsewhere, 'web'), QM_STDIN_CONTROL: '1',
      };
      proc = spawn(process.execPath, [join(elsewhere, 'server.mjs')], { cwd: work, env, stdio: ['pipe', 'pipe', 'pipe'] });
      let out = '';
      proc.stdout!.on('data', (d: Buffer) => (out += d));
      proc.stderr!.on('data', (d: Buffer) => (out += d));
      const exited = new Promise<number | null>((resolve) => proc!.once('exit', (code) => resolve(code)));
      const end = Date.now() + 90_000;
      while (!/QM_READY /.test(out) && proc.exitCode === null && Date.now() < end) await new Promise((r) => setTimeout(r, 50));
      assert.match(out, /QM_READY /, out);

      const base = `http://127.0.0.1:${port}`;
      const get = (path: string) => fetch(`${base}${path}`, { signal: AbortSignal.timeout(10_000) });
      const caps = await get('/api/capabilities');
      assert.equal(caps.status, 200);
      assert.equal(((await caps.json()) as { login: string }).login, 'none');
      // The version the bundle was made with, not read from a package.json beside it
      const settings = await get('/api/local/settings');
      assert.equal(((await settings.json()) as { appVersion: string }).appVersion, pkg.version);
      const index = await get('/');
      assert.equal(index.status, 200);
      const html = await index.text();
      assert.match(html, /<div id="app">/);
      const asset = /(?:src|href)="(\/assets\/[^"]+\.js)"/.exec(html)?.[1];
      assert.ok(asset, 'the index names a script');
      const script = await get(asset);
      assert.equal(script.status, 200);
      assert.match(script.headers.get('content-type') ?? '', /javascript/);
      assert.ok((await script.arrayBuffer()).byteLength > 10_000);
      // The CSP is the strict one: nothing added without QM_CSP_CONNECT
      assert.match(index.headers.get('content-security-policy') ?? '', new RegExp(`connect-src 'self' ws://127\\.0\\.0\\.1:${port}(;|$)`));

      proc.stdin!.write('stop\n');
      const stopTimer = setTimeout(() => proc!.kill(), 15_000);
      assert.equal(await exited, 0, out);
      clearTimeout(stopTimer);
      assert.equal(existsSync(join(data, 'server.lock')), false);
    } finally {
      proc?.kill();
      await new Promise((r) => setTimeout(r, 300));
      rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
    }
  });

  it('refuses a folder that is not a bundle, and reads the start texts from the UI texts', async () => {
    const work = mkdtempSync(join(tmpdir(), 'qm-bundle-'));
    try {
      mkdirSync(join(work, 'precious'));
      cpSync(new URL('../package.json', import.meta.url), join(work, 'precious', 'keep.txt'));
      await assert.rejects(buildBundle({ out: join(work, 'precious') }), /not an app bundle/);
      assert.deepEqual(readdirSync(join(work, 'precious')), ['keep.txt']);
      const texts = startTexts('  "start.starting": "Starting …",\n  "start.languagePack": "Loading language pack …",\n};\nconst de: Record<Key, string> = {\n  "start.starting": "Starte …",\n  "start.languagePack": "Sprachpaket wird geladen …",\n};\n');
      assert.deepEqual(texts.en, { starting: 'Starting …', languagePack: 'Loading language pack …' });
      assert.throws(() => startTexts('const en = {};\nconst de = {};\n'), /no text for start\.starting/);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });
});
