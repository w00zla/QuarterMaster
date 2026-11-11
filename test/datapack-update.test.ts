// The data feed (folder and GitHub with an injected fetch) and the updater, on a folder feed built with buildRelease
// from the fixtures. No network, no Postgres: the database is PGlite in the process. Every wait has a hard limit.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { sql } from 'drizzle-orm';
import { buildRelease, gzipStable, sha256Hex } from '../src/datapack/build.ts';
import { Cancelled, FeedUnavailable, folderFeed, githubFeed, type DataFeed } from '../src/datapack/feed.ts';
import { installedPack } from '../src/datapack/install.ts';
import { DataPackError, tagOf, type Manifest, type ManifestFile } from '../src/datapack/manifest.ts';
import { createDataUpdater } from '../src/datapack/updater.ts';
import { connectPglite, type PgliteConnection } from '../src/db/pglite.ts';
import type { DataUpdateState } from '../src/webapp/api-types.ts';
import { fixtureSnapshot } from './fixtures.ts';

const MIGRATIONS = fileURLToPath(new URL('../drizzle', import.meta.url));
const LABEL = '1.0.1000';
const tag = (n: number) => tagOf(LABEL, n);
const SIZES = ['s', 'm', 'l'];
const uuidOf = (i: number) => `20000000-0000-0000-0000-${i.toString(16).padStart(12, '0')}`;

let root: string;
let counter = 0;
const scratch = (name: string) => {
  const dir = join(root, `${name}-${counter++}`);
  mkdirSync(dir, { recursive: true });
  return dir;
};
const sha256 = sha256Hex;

/** A thumbnails folder: item number -> hash (the content of a picture is its name). */
function makeThumbs(items: Record<number, string>): string {
  const dir = scratch('thumbs');
  const index: Record<string, string> = {};
  for (const [i, hash] of Object.entries(items)) {
    index[uuidOf(Number(i))] = hash;
    for (const size of SIZES) {
      mkdirSync(join(dir, size), { recursive: true });
      writeFileSync(join(dir, size, `${uuidOf(Number(i))}.${hash}.avif`), `fake avif ${size} ${i} ${hash}`);
    }
  }
  writeFileSync(join(dir, 'thumbs.json'), JSON.stringify(index));
  return dir;
}

/** Thumbnail sets: release n has items 1..n (3n pictures); item 1 changes its picture from release 3 on. */
const itemsOf = (n: number): Record<number, string> => {
  const items: Record<number, string> = {};
  for (let i = 1; i <= n; i++) items[i] = i === 1 && n >= 3 ? 'cccccccc' : 'aaaaaaaa';
  return items;
};

describe('data feed and updater', { timeout: 280_000 }, () => {
  let conn: PgliteConnection;
  let snapshotFile: string;

  before(async () => {
    root = mkdtempSync(join(tmpdir(), 'qm-update-'));
    conn = connectPglite(null);
    await conn.migrate(MIGRATIONS);
    const snapshot = fixtureSnapshot();
    snapshot.game.label = LABEL;
    snapshotFile = join(root, 'snapshot.json.gz');
    writeFileSync(snapshotFile, gzipStable(Buffer.from(JSON.stringify(snapshot))));
  });
  after(async () => {
    await conn?.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  });

  /** A feed folder with releases 1..count (each built on its predecessor), channels.json at `stable`. */
  function makeFeed(count: number, stable = count) {
    const dir = scratch('feed');
    for (let n = 1; n <= count; n++) {
      buildRelease({ snapshotFile, thumbsDir: makeThumbs(itemsOf(n)), n, previousDir: n > 1 ? join(dir, tag(n - 1)) : undefined, outDir: join(dir, tag(n)) });
    }
    const setStable = (n: number | null) => writeFileSync(join(dir, 'channels.json'), JSON.stringify(n === null ? { app: { stable: 'v1' } } : { app: { stable: 'v1' }, data: { stable: tag(n) } }));
    setStable(stable);
    return { dir, setStable };
  }

  /** A feed that records what is asked of the inner one. */
  function spy(inner: DataFeed) {
    const downloads: string[] = [];
    const manifests: string[] = [];
    const feed: DataFeed = {
      stableTag: (s) => inner.stableTag(s),
      manifest: (t, s) => { manifests.push(t); return inner.manifest(t, s); },
      download: (t, f, d, o) => { downloads.push(`${t}/${f.name}`); return inner.download(t, f, d, o); },
    };
    return { feed, downloads, manifests };
  }

  describe('folder feed', () => {
    it('reads channels.json and manifests; no data channel and unknown releases are null', async () => {
      const { dir, setStable } = makeFeed(1);
      const feed = folderFeed(dir);
      assert.equal(await feed.stableTag(), tag(1));
      assert.equal((await feed.manifest(tag(1)))?.tag, tag(1));
      assert.equal(await feed.manifest(tag(7)), null);
      setStable(null);
      assert.equal(await feed.stableTag(), null);
      rmSync(join(dir, 'channels.json'));
      assert.equal(await feed.stableTag(), null);
      writeFileSync(join(dir, 'channels.json'), JSON.stringify({ data: { stable: '../../evil' } }));
      await assert.rejects(feed.stableTag(), DataPackError);
      writeFileSync(join(dir, 'channels.json'), 'not json');
      await assert.rejects(feed.stableTag(), DataPackError);
    });

    it('refuses tags and asset names that are paths', async () => {
      const { dir } = makeFeed(1);
      const feed = folderFeed(dir);
      const file: ManifestFile = { name: 'manifest.json', size: 1, sha256: '0'.repeat(64) };
      for (const bad of ['../x', '..', 'data-1.0-1/../../x', 'data-1.0-1/x', '/etc/passwd', 'C:\\x', 'https://evil.example/data-1.0-1', '']) {
        await assert.rejects(feed.manifest(bad), DataPackError, bad);
        await assert.rejects(feed.download(bad, file, join(root, 'never')), DataPackError, bad);
      }
      for (const name of ['../manifest.json', '..\\x', 'a/b', '/abs', '.hidden', '']) {
        await assert.rejects(feed.download(tag(1), { ...file, name }, join(root, 'never')), DataPackError, name);
      }
      assert.equal(existsSync(join(root, 'never')), false);
    });

    it('downloads with progress, and checks size and sha256', async () => {
      const { dir } = makeFeed(1);
      const feed = folderFeed(dir);
      const manifest = (await feed.manifest(tag(1)))!;
      const dest = join(scratch('dl'), 'catalog.json.gz');
      const seen: number[] = [];
      await feed.download(tag(1), manifest.files.catalog, dest, { onProgress: (n) => seen.push(n) });
      assert.equal(readFileSync(dest).length, manifest.files.catalog.size);
      assert.equal(seen.at(-1), manifest.files.catalog.size);

      const bad = join(scratch('dl'), 'x');
      // Wrong hash, right size
      await assert.rejects(feed.download(tag(1), { ...manifest.files.catalog, sha256: 'f'.repeat(64) }, bad), (e: unknown) => e instanceof DataPackError && e.code === 'checksum');
      assert.equal(existsSync(bad), false, 'the partial file is deleted');
      // Too big for what the manifest says, and too small
      await assert.rejects(feed.download(tag(1), { ...manifest.files.catalog, size: manifest.files.catalog.size - 1 }, bad), (e: unknown) => e instanceof DataPackError && e.code === 'checksum');
      await assert.rejects(feed.download(tag(1), { ...manifest.files.catalog, size: manifest.files.catalog.size + 1 }, bad), (e: unknown) => e instanceof DataPackError && e.code === 'checksum');
      assert.equal(existsSync(bad), false);
      // An asset the release does not have
      await assert.rejects(feed.download(tag(1), { ...manifest.files.catalog, name: 'nope.bin' }, bad), DataPackError);
    });
  });

  describe('GitHub feed (injected fetch)', () => {
    const MANIFEST_BYTES = (n: number): Buffer => Buffer.from(JSON.stringify(manifestFor(n)));
    const manifestFor = (n: number): Manifest => ({
      format: 1, tag: tag(n), previous: n > 1 ? tag(n - 1) : null, game: { label: LABEL, build: 1000 }, schemaVersion: 7,
      files: {
        full: { name: `quartermaster-data-${LABEL}-${n}.zip`, size: 5, sha256: '1'.repeat(64) },
        catalog: { name: 'catalog.json.gz', size: 5, sha256: '2'.repeat(64) },
        thumbs: { name: 'thumbs-update.zip', size: 5, sha256: '3'.repeat(64), count: 0 },
      },
    });

    /** A fetch that answers from a table of url -> Response factory and records the urls. */
    const fakeFetch = (table: Record<string, () => Response>) => {
      const urls: string[] = [];
      const impl = (async (input: string | URL | Request) => {
        const url = String(input);
        urls.push(url);
        const make = table[url];
        return make ? make() : new Response('not found', { status: 404 });
      }) as typeof fetch;
      return { fetch: impl, urls };
    };
    const CHANNELS = 'https://raw.githubusercontent.com/w00zla/quartermaster/channels/channels.json';
    const asset = (t: string, a: string) => `https://github.com/w00zla/quartermaster/releases/download/${t}/${a}`;

    it('builds the URLs from the repository constant', async () => {
      const content = Buffer.from('hello');
      const file: ManifestFile = { name: 'catalog.json.gz', size: 5, sha256: sha256(content) };
      const f = fakeFetch({
        [CHANNELS]: () => new Response(JSON.stringify({ app: {}, data: { stable: tag(2) } })),
        [asset(tag(2), 'manifest.json')]: () => new Response(MANIFEST_BYTES(2)),
        [asset(tag(2), 'catalog.json.gz')]: () => new Response(content),
      });
      const feed = githubFeed({ fetch: f.fetch });
      assert.equal(await feed.stableTag(), tag(2));
      assert.equal((await feed.manifest(tag(2)))?.previous, tag(1));
      const dest = join(scratch('gh'), 'c');
      const seen: number[] = [];
      await feed.download(tag(2), file, dest, { onProgress: (n) => seen.push(n) });
      assert.equal(readFileSync(dest, 'utf8'), 'hello');
      assert.equal(seen.at(-1), 5);
      assert.deepEqual(f.urls, [CHANNELS, asset(tag(2), 'manifest.json'), asset(tag(2), 'catalog.json.gz')]);
    });

    it('a missing channels.json, a missing data entry and a missing release are "nothing", an error status is "unavailable"', async () => {
      assert.equal(await githubFeed({ fetch: fakeFetch({}).fetch }).stableTag(), null);
      assert.equal(await githubFeed({ fetch: fakeFetch({ [CHANNELS]: () => new Response('{"app":{"stable":"x"}}') }).fetch }).stableTag(), null);
      assert.equal(await githubFeed({ fetch: fakeFetch({ [CHANNELS]: () => new Response('{"data":{}}') }).fetch }).stableTag(), null);
      assert.equal(await githubFeed({ fetch: fakeFetch({}).fetch }).manifest(tag(1)), null);
      await assert.rejects(githubFeed({ fetch: fakeFetch({ [CHANNELS]: () => new Response('x', { status: 503 }) }).fetch }).stableTag(), FeedUnavailable);
      await assert.rejects(githubFeed({ fetch: fakeFetch({ [CHANNELS]: () => new Response('{"data":{"stable":"../x"}}') }).fetch }).stableTag(), DataPackError);
      const down = (async () => { throw new TypeError('fetch failed'); }) as typeof fetch;
      await assert.rejects(githubFeed({ fetch: down }).stableTag(), FeedUnavailable);
      await assert.rejects(githubFeed({ fetch: down }).download(tag(1), { name: 'catalog.json.gz', size: 1, sha256: '0'.repeat(64) }, join(root, 'never')), FeedUnavailable);
    });

    it('a hostile tag or asset name never reaches fetch', async () => {
      const f = fakeFetch({});
      const feed = githubFeed({ fetch: f.fetch });
      const file: ManifestFile = { name: 'catalog.json.gz', size: 1, sha256: '0'.repeat(64) };
      await assert.rejects(feed.manifest('../../evil/x'), DataPackError);
      await assert.rejects(feed.download('data-1.0-1/../../x', file, join(root, 'never')), DataPackError);
      await assert.rejects(feed.download(tag(1), { ...file, name: '../x' }, join(root, 'never')), DataPackError);
      await assert.rejects(feed.download(tag(1), { ...file, name: 'a/b' }, join(root, 'never')), DataPackError);
      assert.deepEqual(f.urls, []);
    });

    it('a manifest of another release is refused; a redirect to another host is refused', async () => {
      const wrong = githubFeed({ fetch: fakeFetch({ [asset(tag(2), 'manifest.json')]: () => new Response(MANIFEST_BYTES(3)) }).fetch });
      await assert.rejects(wrong.manifest(tag(2)), DataPackError);
      const away = () => {
        const res = new Response('x');
        Object.defineProperty(res, 'url', { value: 'https://evil.example/asset' });
        return res;
      };
      const feed = githubFeed({ fetch: fakeFetch({ [asset(tag(1), 'catalog.json.gz')]: away }).fetch });
      await assert.rejects(feed.download(tag(1), { name: 'catalog.json.gz', size: 1, sha256: '0'.repeat(64) }, join(root, 'never')), FeedUnavailable);
      const ok = () => {
        const res = new Response('x');
        Object.defineProperty(res, 'url', { value: 'https://release-assets.githubusercontent.com/abc' });
        return res;
      };
      const good = githubFeed({ fetch: fakeFetch({ [asset(tag(1), 'catalog.json.gz')]: ok }).fetch });
      const dest = join(scratch('gh'), 'c');
      await good.download(tag(1), { name: 'catalog.json.gz', size: 1, sha256: sha256(Buffer.from('x')) }, dest);
      assert.equal(readFileSync(dest, 'utf8'), 'x');
    });

    it('checksum mismatch and wrong sizes delete the partial file', async () => {
      const content = Buffer.from('hello');
      const feed = githubFeed({ fetch: fakeFetch({ [asset(tag(1), 'catalog.json.gz')]: () => new Response(content) }).fetch });
      const dest = join(scratch('gh'), 'c');
      const good = sha256(content);
      await assert.rejects(feed.download(tag(1), { name: 'catalog.json.gz', size: 5, sha256: 'e'.repeat(64) }, dest), (e: unknown) => e instanceof DataPackError && e.code === 'checksum');
      await assert.rejects(feed.download(tag(1), { name: 'catalog.json.gz', size: 4, sha256: good }, dest), (e: unknown) => e instanceof DataPackError && e.code === 'checksum');
      await assert.rejects(feed.download(tag(1), { name: 'catalog.json.gz', size: 6, sha256: good }, dest), (e: unknown) => e instanceof DataPackError && e.code === 'checksum');
      assert.equal(existsSync(dest), false);
    });

    it('a stalled download is dropped as unavailable (partial file deleted); an abort is Cancelled', async () => {
      const stalling = ((_url: string, init?: RequestInit) => {
        let controller!: ReadableStreamDefaultController<Uint8Array>;
        const body = new ReadableStream<Uint8Array>({ start(c) { controller = c; c.enqueue(Buffer.from('he')); } });
        init?.signal?.addEventListener('abort', () => controller.error(new Error('aborted')));
        return Promise.resolve(new Response(body));
      }) as unknown as typeof fetch;
      const feed = githubFeed({ fetch: stalling, stallTimeoutMs: 150, connectTimeoutMs: 150 });
      const dest = join(scratch('gh'), 'c');
      const file = { name: 'catalog.json.gz', size: 5, sha256: '0'.repeat(64) };
      await assert.rejects(feed.download(tag(1), file, dest), FeedUnavailable);
      assert.equal(existsSync(dest), false);
      const ctl = new AbortController();
      const running = feed.download(tag(1), file, dest, { signal: ctl.signal });
      setTimeout(() => ctl.abort(), 30);
      await assert.rejects(running, Cancelled);
      assert.equal(existsSync(dest), false);
    });
  });

  describe('updater', () => {
    /** A fresh data folder and an updater on the shared in-memory database. */
    function make(feed: DataFeed, extra: { appSchemaVersion?: number } = {}) {
      const dataDir = scratch('data');
      const logs: string[] = [];
      const updater = createDataUpdater({ connection: conn, dataDir, thumbsDir: join(dataDir, 'thumbs'), feed, log: (m) => logs.push(m), ...extra });
      return { updater, dataDir, logs };
    }
    const pictures = (dataDir: string) => SIZES.flatMap((s) => (existsSync(join(dataDir, 'thumbs', s)) ? readdirSync(join(dataDir, 'thumbs', s)) : [])).length;
    const leftovers = (dataDir: string) => ['downloads'].filter((n) => existsSync(join(dataDir, n)));

    it('first install from an empty folder (the full pack), then up to date', async () => {
      const { dir } = makeFeed(1);
      const s = spy(folderFeed(dir));
      const { updater, dataDir } = make(s.feed);
      assert.deepEqual(updater.state(), { phase: 'idle', installed: null, progress: null, last: null });
      const state = await updater.check();
      assert.equal(state.phase, 'idle');
      assert.equal(state.last?.outcome, 'installed');
      assert.deepEqual(state.installed, { tag: tag(1), gameLabel: LABEL });
      assert.deepEqual(s.downloads, [`${tag(1)}/quartermaster-data-${LABEL}-1.zip`]);
      assert.equal(installedPack(dataDir)?.tag, tag(1));
      assert.equal(pictures(dataDir), 3);
      assert.deepEqual(leftovers(dataDir), []);
      assert.ok(Number((await conn.db.execute<{ n: string }>(sql`SELECT count(*)::text AS n FROM catalog.item`))[0]!.n) > 0);

      s.downloads.length = 0;
      const again = await updater.check();
      assert.equal(again.last?.outcome, 'upToDate');
      assert.deepEqual(s.downloads, []);
    });

    it('a new release: the chain fetches only the catalog and the thumbs update', async () => {
      const { dir, setStable } = makeFeed(2, 1);
      const s = spy(folderFeed(dir));
      const { updater, dataDir, logs } = make(s.feed);
      await updater.check();
      assert.equal(updater.state().installed?.tag, tag(1));
      s.downloads.length = 0;
      setStable(2);
      const state = await updater.check();
      assert.equal(state.last?.outcome, 'installed');
      assert.equal(state.installed?.tag, tag(2));
      assert.deepEqual(s.downloads.sort(), [`${tag(2)}/catalog.json.gz`, `${tag(2)}/thumbs-update.zip`]);
      assert.equal(pictures(dataDir), 6);
      assert.deepEqual(leftovers(dataDir), []);
      assert.ok(logs.some((l) => /plan chain/.test(l)) && logs.some((l) => /install: \d+ ms/.test(l)) && logs.some((l) => /download .*MB: \d+ ms/.test(l)));
    });

    it('a jump over three releases: the newest catalog and the thumbs updates of all three', async () => {
      const { dir, setStable } = makeFeed(4, 1);
      const s = spy(folderFeed(dir));
      const { updater, dataDir } = make(s.feed);
      await updater.check();
      s.downloads.length = 0;
      setStable(4);
      const state = await updater.check();
      assert.equal(state.installed?.tag, tag(4));
      assert.deepEqual(s.downloads, [
        `${tag(4)}/catalog.json.gz`, `${tag(2)}/thumbs-update.zip`, `${tag(3)}/thumbs-update.zip`, `${tag(4)}/thumbs-update.zip`,
      ]);
      // Exactly release 4's pictures (item 1's old one is gone)
      assert.equal(pictures(dataDir), 12);
      assert.deepEqual(leftovers(dataDir), []);
    });

    it('a chain that cannot be built (a release is gone): the full pack', async () => {
      const { dir, setStable } = makeFeed(3, 1);
      const s = spy(folderFeed(dir));
      const { updater, dataDir, logs } = make(s.feed);
      await updater.check();
      s.downloads.length = 0;
      rmSync(join(dir, tag(2)), { recursive: true });
      setStable(3);
      const state = await updater.check();
      assert.equal(state.last?.outcome, 'installed');
      assert.deepEqual(s.downloads, [`${tag(3)}/quartermaster-data-${LABEL}-3.zip`]);
      assert.ok(logs.some((l) => /plan full \(chainBroken\)/.test(l)));
      assert.equal(pictures(dataDir), 9);
    });

    it('a pack with another schema: appTooOld (newer or older), nothing downloaded or touched', async () => {
      const { dir } = makeFeed(1);
      for (const [app, pack] of [[6, 'newer'], [8, 'older']] as const) {
        const s = spy(folderFeed(dir));
        const { updater, dataDir } = make(s.feed, { appSchemaVersion: app });
        const state = await updater.check();
        assert.deepEqual({ ...state.last, at: undefined }, { at: undefined, outcome: 'appTooOld', tag: tag(1), pack });
        assert.equal(state.installed, null);
        assert.deepEqual(s.downloads, []);
        assert.deepEqual(readdirSync(dataDir), []);
      }
    });

    it('no data channel, and a feed that cannot be reached: noChannel / offline, an installed pack stays usable', async () => {
      const { dir, setStable } = makeFeed(1);
      const { updater, dataDir } = make(folderFeed(dir));
      await updater.check();
      setStable(null);
      assert.equal((await updater.check()).last?.outcome, 'noChannel');

      const broken: DataFeed = { ...folderFeed(dir), stableTag: async () => { throw new FeedUnavailable('no network'); } };
      const offline = createDataUpdater({ connection: conn, dataDir, thumbsDir: join(dataDir, 'thumbs'), feed: broken, log: () => {} });
      assert.equal(offline.state().installed?.tag, tag(1), 'the installed pack is read from the folder at start');
      const state = await offline.check();
      assert.equal(state.last?.outcome, 'offline');
      assert.equal(state.phase, 'idle');
      assert.equal(state.installed?.tag, tag(1));
      assert.equal(pictures(dataDir), 3);
      assert.ok((await conn.db.execute(sql`SELECT 1 AS x`))[0]);

      // A download that breaks half way is offline as well
      const { dir: dir2 } = makeFeed(1);
      const inner = folderFeed(dir2);
      const dropping: DataFeed = { ...inner, download: async () => { throw new FeedUnavailable('connection reset'); } };
      const fresh = make(dropping);
      assert.equal((await fresh.updater.check()).last?.outcome, 'offline');
      assert.deepEqual(leftovers(fresh.dataDir), []);
    });

    it('a failed checksum installs nothing and leaves no temp files', async () => {
      const { dir, setStable } = makeFeed(2, 1);
      const { updater, dataDir } = make(folderFeed(dir));
      await updater.check();
      // The thumbs update of release 2, one byte changed (same size)
      const file = join(dir, tag(2), 'thumbs-update.zip');
      const bytes = readFileSync(file);
      bytes.writeUInt8(bytes.readUInt8(bytes.length - 1) ^ 0xff, bytes.length - 1);
      writeFileSync(file, bytes);
      setStable(2);
      const state = await updater.check();
      assert.deepEqual({ ...state.last, at: undefined }, { at: undefined, outcome: 'failed', reason: 'corrupt' });
      assert.equal(state.installed?.tag, tag(1));
      assert.equal(installedPack(dataDir)?.tag, tag(1));
      assert.equal(pictures(dataDir), 3);
      assert.deepEqual(leftovers(dataDir), []);
    });

    it('cleans up the downloads folder of an earlier crash at start', () => {
      const dataDir = scratch('data');
      mkdirSync(join(dataDir, 'downloads'), { recursive: true });
      writeFileSync(join(dataDir, 'downloads', 'half.zip'), 'x');
      createDataUpdater({ connection: conn, dataDir, thumbsDir: join(dataDir, 'thumbs'), feed: folderFeed(scratch('feed')), log: () => {} });
      assert.equal(existsSync(join(dataDir, 'downloads')), false);
    });

    it('single flight: a second call while one runs returns the running state', async () => {
      const { dir } = makeFeed(1);
      const inner = folderFeed(dir);
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      let asked = 0;
      const slow: DataFeed = { ...inner, stableTag: async (s) => { asked++; await gate; return inner.stableTag(s); } };
      const { updater } = make(slow);
      const first = updater.check();
      assert.equal(updater.state().phase, 'checking');
      const second = await updater.check();
      assert.equal(second.phase, 'checking');
      const third = await updater.importFile(join(dir, tag(1), `quartermaster-data-${LABEL}-1.zip`));
      assert.equal(third.phase, 'checking');
      release();
      const done = await first;
      assert.equal(asked, 1);
      assert.equal(done.phase, 'idle');
      assert.equal(done.last?.outcome, 'installed');
    });

    it('importFile: a full pack the user picked; a missing file, a folder and a non-pack are failures, not exceptions', async () => {
      const { dir } = makeFeed(1);
      const { updater, dataDir } = make(folderFeed(scratch('feed')));
      const pack = join(dir, tag(1), `quartermaster-data-${LABEL}-1.zip`);
      const state = await updater.importFile(pack);
      assert.deepEqual({ ...state.last, at: undefined }, { at: undefined, outcome: 'installed', tag: tag(1) });
      assert.equal(state.installed?.tag, tag(1));
      assert.equal(pictures(dataDir), 3);

      const reason = async (path: string) => {
        const s = await updater.importFile(path);
        return s.last?.outcome === 'failed' ? s.last.reason : s.last?.outcome;
      };
      assert.equal(await reason(join(root, 'nope.zip')), 'fileMissing');
      assert.equal(await reason(root), 'fileMissing');
      const junk = join(scratch('junk'), 'junk.zip');
      writeFileSync(junk, 'this is not a data pack at all');
      assert.equal(await reason(junk), 'invalid');
      const s: DataUpdateState = updater.state();
      assert.equal(s.installed?.tag, tag(1));
    });

    it('stop() aborts a download and waits; nothing is left behind', async () => {
      const { dir } = makeFeed(1);
      const inner = folderFeed(dir);
      let started!: () => void;
      const began = new Promise<void>((r) => (started = r));
      const hanging: DataFeed = {
        ...inner,
        download: (_t, _f, _d, o) => new Promise((_, reject) => {
          started();
          o?.signal?.addEventListener('abort', () => reject(new Cancelled()));
        }),
      };
      const { updater, dataDir } = make(hanging);
      const run = updater.check();
      await began;
      assert.equal(updater.state().phase, 'downloading');
      await updater.stop();
      const state = await run;
      assert.equal(state.phase, 'idle');
      assert.equal(state.last, null, 'a cancelled run is no outcome');
      assert.deepEqual(leftovers(dataDir), []);
    });
  });
});
