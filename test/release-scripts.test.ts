// The release scripts (scripts/release-lib.mjs, channels-*.mjs, latest-json.mjs; docs/releasing.md): tags, channels.json
// updates and the updater feed. channels.json (on the `channels` branch) must stay in the shape the readers expect
// (app/src-tauri/src/update.rs, src/datapack/feed.ts); test/release-feed/channels.json is the "nothing released" file.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
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
interface Scope {
  decide(job: string, files: string[]): { run: boolean; reason: string };
}
interface Lib {
  parseTag(tag: string): Record<string, unknown> | null;
  compareVersions(a: string, b: string): number;
  assetNames(product: 'app' | 'companion', version: string): { windows: string; linux: string };
  readChannels(path: string): Channels;
  pointAt(json: Channels, tag: string): { changed: boolean; message: string };
  removeChannel(json: Channels, product: string, id: string): { changed: boolean; message: string };
  downloadsTable(json: Channels): string;
  replaceDownloads(readme: string, table: string): string;
}

const root = fileURLToPath(new URL('../', import.meta.url));
const feedDir = join(root, 'test', 'release-feed');
const lib = new URL('../scripts/release-lib.mjs', import.meta.url).href;
const { assetNames, compareVersions, downloadsTable, parseTag, pointAt, readChannels, removeChannel, replaceDownloads } = (await import(lib)) as Lib;
const { decide } = (await import(new URL('../scripts/ci-scope.mjs', import.meta.url).href)) as Scope;
const empty = () => readChannels(join(feedDir, 'channels.json'));

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

  it('the "nothing released" file is "no data channel" for the data feed reader', async () => {
    assert.equal(await folderFeed(feedDir).stableTag(), null);
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

  it('removes a channel entry, never stable, and leaves the rest alone', () => {
    const json = empty();
    pointAt(json, 'app-v1.0.0');
    pointAt(json, 'app-v1.1.0-beta.1');
    pointAt(json, 'app-v1.1.0-rc.1');
    assert.equal(removeChannel(json, 'app', 'beta').changed, true);
    assert.equal(removeChannel(json, 'app', 'beta').changed, false);
    assert.equal(removeChannel(json, 'companion', 'beta').changed, false);
    assert.deepEqual(json.app, { stable: 'app-v1.0.0', channels: [{ id: 'rc', tag: 'app-v1.1.0-rc.1' }] });
    assert.throws(() => removeChannel(json, 'app', 'stable'));
    assert.throws(() => removeChannel(json, 'app', 'Bad Id'));
    assert.throws(() => removeChannel(json, 'data', 'beta'));
  });

  it('the scripts edit a file: channels-set creates the file when it is missing, channels-remove edits it', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'qm-channels-')), 'channels.json');
    const run = (script: string, ...args: string[]) => execFileSync(process.execPath, [join(root, 'scripts', script), ...args, file], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    run('channels-set.mjs', 'app-v1.1.0-beta.1');
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')).app.channels, [{ id: 'beta', tag: 'app-v1.1.0-beta.1' }]);
    assert.match(run('channels-remove.mjs', 'app', 'beta'), /removed/);
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')).app.channels, []);
    assert.match(run('channels-remove.mjs', 'app', 'beta'), /unchanged/);
    assert.throws(() => run('channels-remove.mjs', 'app', 'stable'));
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

describe('README downloads block', () => {
  const block = (table: string) => `# Title\n\n<div id="release_dls">\n\n${table}\n\n</div>\n\nMore text.\n`;

  it('links every file of the stable releases, the first per platform in bold; nothing released says so', () => {
    const json = empty();
    assert.ok(downloadsTable(json).includes('| **Quartermaster (singleuser)** | not released yet | not released yet |'));
    pointAt(json, 'app-v1.0.0');
    pointAt(json, 'companion-v2.1.0');
    pointAt(json, 'companion-v2.2.0-beta.1');
    const table = downloadsTable(json);
    const url = (tag: string, name: string) => `https://github.com/w00zla/quartermaster/releases/download/${tag}/${name}`;
    assert.ok(table.includes(`| **Quartermaster (singleuser)** | **[Installer](${url('app-v1.0.0', 'Quartermaster_1.0.0_x64-setup.exe')})** | **[AppImage](${url('app-v1.0.0', 'Quartermaster_1.0.0_amd64.AppImage')})** |`));
    for (const name of ['Quartermaster-Companion_2.1.0_x64-setup.exe', 'Quartermaster-Companion_2.1.0_x64-standalone.zip', 'Quartermaster-Companion_2.1.0_amd64.AppImage', 'Quartermaster-Companion_2.1.0_amd64.deb', 'Quartermaster-Companion-2.1.0-1.x86_64.rpm']) {
      assert.ok(table.includes(url('companion-v2.1.0', name)), name);
    }
    assert.ok(!table.includes('beta'), 'a channel release is not in the block');
  });

  it('replaces only the block, is stable on a second run and refuses a README without one', () => {
    const json = empty();
    pointAt(json, 'app-v1.0.0');
    const once = replaceDownloads(block('old table'), downloadsTable(json));
    assert.ok(once.startsWith('# Title\n\n<div id="release_dls">\n\n| | Windows | Linux |'));
    assert.ok(once.endsWith('\n\n</div>\n\nMore text.\n'));
    assert.ok(!once.includes('old table'));
    assert.equal(replaceDownloads(once, downloadsTable(json)), once);
    assert.throws(() => replaceDownloads('# no block\n', 'x'), /no downloads block/);
  });

  it('the script edits the README file and says when nothing changed', () => {
    const dir = mkdtempSync(join(tmpdir(), 'qm-readme-'));
    const channels = join(dir, 'channels.json');
    const readme = join(dir, 'README.md');
    writeFileSync(readme, block('old table'));
    const run = () => execFileSync(process.execPath, [join(root, 'scripts', 'readme-downloads.mjs'), channels, readme], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    execFileSync(process.execPath, [join(root, 'scripts', 'channels-set.mjs'), 'companion-v2.1.0', channels], { stdio: 'ignore' });
    assert.match(run(), /rewritten/);
    assert.ok(readFileSync(readme, 'utf8').includes('companion-v2.1.0/Quartermaster-Companion_2.1.0_amd64.deb'));
    assert.match(run(), /unchanged/);
  });

  it("the repository's README has the downloads block", () => {
    const readme = readFileSync(join(root, 'README.md'), 'utf8');
    assert.doesNotThrow(() => replaceDownloads(readme, 'x'));
  });
});

describe('ci.yml scope (scripts/ci-scope.mjs)', () => {
  it('the node job skips docs-only pull requests and runs for anything else', () => {
    assert.equal(decide('node', ['docs/app.md', 'README.md', 'tools/releasectl/run.py', '.github/workflows/build-app.yml']).run, false);
    assert.equal(decide('node', ['docs/app.md', 'src/stock/service.ts']).run, true);
    assert.equal(decide('node', ['.github/workflows/ci.yml']).run, true);
    assert.equal(decide('node', ['scripts/ci-scope.mjs']).run, true);
  });

  it('the Rust jobs run for their own folders, the workflow and (app) the root package.json only', () => {
    assert.equal(decide('app-rust', ['app/src-tauri/src/update.rs']).run, true);
    assert.equal(decide('app-rust', ['package.json']).run, true);
    assert.equal(decide('app-rust', ['companion/src-tauri/src/update.rs', 'src/datapack/feed.ts']).run, false);
    assert.equal(decide('companion-rust', ['companion/src-tauri/Cargo.toml']).run, true);
    assert.equal(decide('companion-rust', ['package.json', 'app/src-tauri/src/update.rs']).run, false);
    assert.equal(decide('companion-rust', ['.github/workflows/ci.yml']).run, true);
  });

  it('an empty list runs the job; an unknown job is an error', () => {
    assert.equal(decide('app-rust', []).run, true);
    assert.throws(() => decide('nope', ['x']));
  });
});
