// The release scripts (scripts/release-lib.mjs, latest-json.mjs; docs/releasing.md): tags, channels.json updates, the
// README table and the updater feed. channels.json must stay in the shape the readers expect (app/src-tauri/src/update.rs,
// src/datapack/feed.ts).
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { folderFeed } from '../src/datapack/feed.ts';

interface Channels {
  app: { stable: string | null; channels: { id: string; tag: string }[] };
  companion: { stable: string | null; channels: { id: string; tag: string }[] };
  data: { stable: string | null };
}
interface Lib {
  parseTag(tag: string): Record<string, unknown> | null;
  compareVersions(a: string, b: string): number;
  assetNames(product: 'app' | 'companion', version: string): { windows: string; linux: string };
  readChannels(path: string): Channels;
  pointAt(json: Channels, tag: string): { changed: boolean; message: string };
  downloadTable(json: Channels): string;
}

const root = fileURLToPath(new URL('../', import.meta.url));
const lib = new URL('../scripts/release-lib.mjs', import.meta.url).href;
const { assetNames, compareVersions, downloadTable, parseTag, pointAt, readChannels } = (await import(lib)) as Lib;
const empty = () => readChannels(join(root, 'channels.json'));

describe('release tags', () => {
  it('parses the three kinds and refuses the rest', () => {
    assert.deepEqual(parseTag('app-v1.2.3'), { product: 'app', version: '1.2.3', channel: null, tag: 'app-v1.2.3' });
    assert.equal(parseTag('companion-v2.1.0-beta.4')?.channel, 'beta');
    assert.deepEqual(parseTag('data-4.10.2.12913470-1'), { product: 'data', tag: 'data-4.10.2.12913470-1', label: '4.10.2.12913470', n: 1 });
    for (const bad of ['v1.2.3', 'app-1.2.3', 'app-v1.2', 'app-v1.2.3-beta', 'app-v1.2.3-stable.1', 'app-v1.2.3-Beta.1', 'app-v01.2.3', 'data-x-0', 'data-4.10']) {
      assert.equal(parseTag(bad), null, bad);
    }
  });

  it('orders versions: a plain one beats its pre-releases, counters count numerically', () => {
    assert.equal(compareVersions('1.0.0', '1.0.0-beta.3'), 1);
    assert.equal(compareVersions('1.0.0-beta.2', '1.0.0-beta.10'), -1);
    assert.equal(compareVersions('0.9.9', '1.0.0-beta.1'), -1);
    assert.equal(compareVersions('1.0.0', '1.0.0'), 0);
  });
});

describe('channels.json', () => {
  it('starts with nothing released, in the shape the readers take as "no update"', () => {
    assert.deepEqual(empty(), { app: { stable: null, channels: [] }, companion: { stable: null, channels: [] }, data: { stable: null } });
  });

  it('the committed file is "no data channel" for the data feed reader', async () => {
    assert.equal(await folderFeed(root).stableTag(), null);
  });

  it('points stable, a channel and the data tag, and never moves back', () => {
    const json = empty();
    assert.equal(pointAt(json, 'app-v1.0.0').changed, true);
    assert.equal(pointAt(json, 'app-v1.1.0-beta.1').changed, true);
    assert.equal(pointAt(json, 'app-v1.1.0-beta.2').changed, true);
    assert.equal(pointAt(json, 'app-v1.1.0-beta.1').changed, false);
    assert.equal(pointAt(json, 'app-v0.9.0').changed, false);
    assert.equal(pointAt(json, 'companion-v2.2.0').changed, true);
    assert.equal(pointAt(json, 'data-4.10.2.1-2').changed, true);
    assert.equal(pointAt(json, 'data-4.10.2.1-1').changed, false);
    assert.equal(pointAt(json, 'data-4.10.10.1-1').changed, true);
    assert.deepEqual(json, {
      app: { stable: 'app-v1.0.0', channels: [{ id: 'beta', tag: 'app-v1.1.0-beta.2' }] },
      companion: { stable: 'companion-v2.2.0', channels: [] },
      data: { stable: 'data-4.10.10.1-1' },
    });
    assert.throws(() => pointAt(json, 'v1.0.0'));
  });

  it('writes the README table from it', () => {
    const json = empty();
    pointAt(json, 'app-v1.1.0-beta.1');
    const table = downloadTable(json);
    assert.match(table, /\| Quartermaster \| stable \| not released yet \|/);
    assert.match(table, /releases\/download\/app-v1\.1\.0-beta\.1\/Quartermaster_1\.1\.0-beta\.1_x64-setup\.exe/);
    assert.match(table, /\| Quartermaster Companion \| stable \| not released yet \|/);
  });
});

describe('latest.json', () => {
  it('names the assets of exactly the release, with their signatures', () => {
    const dir = mkdtempSync(join(tmpdir(), 'qm-latest-'));
    const names = assetNames('companion', '2.2.0-beta.1');
    writeFileSync(join(dir, names.windows), 'x');
    writeFileSync(join(dir, `${names.windows}.sig`), 'SIGNATURE\n');
    const out = execFileSync(process.execPath, [join(root, 'scripts', 'latest-json.mjs'), 'companion-v2.2.0-beta.1', dir], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const feed = JSON.parse(out);
    assert.equal(feed.version, '2.2.0-beta.1');
    assert.deepEqual(Object.keys(feed.platforms), ['windows-x86_64']);
    assert.equal(feed.platforms['windows-x86_64'].signature, 'SIGNATURE');
    assert.ok(feed.platforms['windows-x86_64'].url.endsWith(`/releases/download/companion-v2.2.0-beta.1/${names.windows}`));
    assert.throws(() => execFileSync(process.execPath, [join(root, 'scripts', 'latest-json.mjs'), 'app-v1.0.0', dir], { stdio: 'ignore' }));
  });
});
