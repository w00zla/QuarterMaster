// The data pack: slim snapshot, ZIP reader/writer, building a release, installing it. Synthetic data only (the
// fixtures' snapshot, a few tiny fake AVIFs). Needs no Postgres: the database is PGlite in the process.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { sql } from 'drizzle-orm';
import { gunzipSync } from 'node:zlib';
import { runImport, type ImportOptions } from '../src/catalog/import/apply.ts';
import { loadSnapshot } from '../src/catalog/import/load.ts';
import { gzipStable, buildRelease, sha256Hex } from '../src/datapack/build.ts';
import { DataPackError, parseManifest, type Manifest } from '../src/datapack/manifest.ts';
import { INSTALLED_FILE, installPack, installedPack } from '../src/datapack/install.ts';
import { connectPglite, type PgliteConnection } from '../src/db/pglite.ts';
import { ZIP_EPOCH, isSafeZipName, openZip, zip } from '../src/zip.ts';
import { fixtureSnapshot } from './fixtures.ts';

const MIGRATIONS = fileURLToPath(new URL('../drizzle', import.meta.url));
const NORMAL: ImportOptions = { dryRun: false, force: false, allowDowngrade: false, maxRetireRatio: 0.1, maxChangeRatio: 0.5 };
const LABEL = '1.0.1000';

const uuidOf = (i: number) => `20000000-0000-0000-0000-${i.toString(16).padStart(12, '0')}`;
const SIZES = ['s', 'm', 'l'];

let root: string;
const scratch = (name: string) => {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  return dir;
};

/** A thumbnails folder: item number -> hash; every picture's content is its own name. */
function makeThumbs(name: string, items: Record<number, string>): string {
  const dir = scratch(name);
  const index: Record<string, string> = {};
  for (const [i, hash] of Object.entries(items)) {
    index[uuidOf(Number(i))] = hash;
    for (const size of SIZES) {
      mkdirSync(join(dir, size), { recursive: true });
      writeFileSync(join(dir, size, `${uuidOf(Number(i))}.${hash}.avif`), `fake avif ${size} ${i} ${hash}`);
    }
  }
  // Unreferenced pictures must not go into any pack
  mkdirSync(join(dir, 's'), { recursive: true });
  writeFileSync(join(dir, 's', `${uuidOf(999)}.deadbeef.avif`), 'stray');
  writeFileSync(join(dir, 'thumbs.json'), JSON.stringify(index, null, 1));
  return dir;
}

const files = (dir: string) => SIZES.flatMap((s) => (existsSync(join(dir, s)) ? readdirSync(join(dir, s)).map((f) => `${s}/${f}`) : [])).sort();
const names = (path: string) => { const z = openZip(path); try { return z.entries.map((e) => e.name); } finally { z.close(); } };

describe('data pack', () => {
  let conn: PgliteConnection;
  let snapshotFile: string;
  const count = async (table: string) => Number((await conn.db.execute<{ n: string }>(sql.raw(`SELECT count(*)::text AS n FROM catalog.${table}`)))[0]!.n);

  before(async () => {
    root = mkdtempSync(join(tmpdir(), 'qm-datapack-'));
    conn = connectPglite(null);
    await conn.migrate(MIGRATIONS);
    const snapshot = fixtureSnapshot();
    snapshot.game.label = LABEL;
    snapshotFile = join(root, 'snapshot.json.gz');
    writeFileSync(snapshotFile, gzipStable(Buffer.from(JSON.stringify(snapshot))));
  });
  after(async () => {
    await conn?.close();
    rmSync(root, { recursive: true, force: true });
  });

  describe('slim snapshot', () => {
    it('loads without rawRecords (absent = empty)', () => {
      const full = JSON.parse(gunzipSync(readFileSync(snapshotFile)).toString('utf8'));
      assert.ok(full.rawRecords.length >= 3);
      delete full.rawRecords;
      const loaded = loadSnapshot(Buffer.from(JSON.stringify(full)));
      assert.deepEqual(loaded.snapshot.rawRecords, []);
    });

    it('imports into an empty database; into one with raw records the normal guards still block it', async () => {
      const dir = scratch('slim-db');
      const own = connectPglite(join(dir, 'db'));
      try {
        await own.migrate(MIGRATIONS);
        const full = loadSnapshot(readFileSync(snapshotFile));
        const slim = { ...full.snapshot, rawRecords: [] };
        const r1 = await runImport(own.db, slim, 'slim-1', NORMAL);
        assert.equal(r1.status, 'imported');
        const raw = async () => Number((await own.db.execute<{ n: string }>(sql`SELECT count(*)::text AS n FROM catalog.raw_record WHERE retired_at IS NULL`))[0]!.n);
        assert.equal(await raw(), 0);

        // Raw records in, then the slim one over them: the mass-retire guard
        const r2 = await runImport(own.db, full.snapshot, 'full-1', NORMAL);
        assert.equal(r2.status, 'imported');
        assert.ok((await raw()) >= 3);
        const r3 = await runImport(own.db, slim, 'slim-2', NORMAL);
        assert.equal(r3.status, 'blocked');
        assert.ok(r3.safeguards.violations.some((v) => v.code === 'mass_retire'));
        assert.ok((await raw()) >= 3, 'nothing was written');
      } finally {
        await own.close();
      }
    });
  });

  describe('zip', () => {
    it('writes and reads back, with CRC check, and a fixed date gives identical bytes', () => {
      const a = zip([{ name: 'a.txt', data: Buffer.from('hello') }, { name: 'd/b.bin', data: Buffer.alloc(0) }], ZIP_EPOCH);
      assert.ok(a.equals(zip([{ name: 'a.txt', data: Buffer.from('hello') }, { name: 'd/b.bin', data: Buffer.alloc(0) }], ZIP_EPOCH)));
      const file = join(root, 'a.zip');
      writeFileSync(file, a);
      const z = openZip(file);
      assert.deepEqual(z.entries.map((e) => e.name), ['a.txt', 'd/b.bin']);
      assert.equal(z.read('a.txt').toString(), 'hello');
      assert.equal(z.read('d/b.bin').length, 0);
      z.close();
      // Damage the content: the CRC refuses it
      const bad = Buffer.from(a);
      bad[bad.indexOf('hello')] = 0x48;
      writeFileSync(file, bad);
      const z2 = openZip(file);
      assert.throws(() => z2.read('a.txt'), /CRC/);
      z2.close();
    });

    it('refuses unsafe entry names', () => {
      for (const name of ['../x', 'a/../../x', '/abs', 'C:/x', 'c:x', 'a\\b', 'a//b', './x', '']) assert.equal(isSafeZipName(name), false, name);
      for (const name of ['a', 'm/00.avif', 'thumbs.json']) assert.equal(isSafeZipName(name), true, name);
      const file = join(root, 'evil.zip');
      writeFileSync(file, zip([{ name: '../evil.txt', data: Buffer.from('x') }]));
      assert.throws(() => openZip(file), /unsafe entry name/);
    });

    it('refuses a file that is not a ZIP and too many entries', () => {
      const file = join(root, 'no.zip');
      writeFileSync(file, 'not a zip at all, just some text that is long enough');
      assert.throws(() => openZip(file), /not a ZIP/);
      assert.throws(() => zip(Array.from({ length: 0xffff }, (_, i) => ({ name: `f${i}`, data: Buffer.alloc(0) }))), /ZIP64/);
    });
  });

  describe('release', () => {
    const v1 = { 1: 'aaaaaaaa', 2: 'bbbbbbbb', 3: 'cccccccc' };
    const v2 = { 1: 'aaaaaaaa', 3: 'c3c3c3c3', 4: 'dddddddd' }; // 2 removed, 3 changed, 4 added
    let thumbs1: string;
    let thumbs2: string;
    let rel1: string;
    let rel2: string;
    let m1: Manifest;
    let m2: Manifest;

    before(() => {
      thumbs1 = makeThumbs('thumbs1', v1);
      thumbs2 = makeThumbs('thumbs2', v2);
      rel1 = join(root, 'rel1');
      rel2 = join(root, 'rel2');
    });

    it('builds a first release: four assets, the manifest, the pictures of thumbs.json only', () => {
      const r = buildRelease({ snapshotFile, thumbsDir: thumbs1, n: 1, outDir: rel1 });
      assert.equal(r.tag, `data-${LABEL}-1`);
      assert.deepEqual(r.assets.map((a) => a.name), ['manifest.json', `quartermaster-data-${LABEL}-1.zip`, 'catalog.json.gz', 'thumbs-update.zip']);
      assert.deepEqual(r.thumbs, { total: 9, added: 9 });
      m1 = parseManifest(JSON.parse(readFileSync(join(rel1, 'manifest.json'), 'utf8')));
      assert.equal(m1.previous, null);
      assert.equal(m1.schemaVersion, 8);
      assert.equal(m1.game.build, 1000);
      assert.equal(m1.files.thumbs.count, 9);
      for (const f of [m1.files.full, m1.files.catalog, m1.files.thumbs]) {
        const bytes = readFileSync(join(rel1, f.name));
        assert.equal(bytes.length, f.size);
        assert.equal(sha256Hex(bytes), f.sha256);
      }
      const full = names(join(rel1, m1.files.full.name));
      assert.deepEqual(full.slice(0, 3), ['manifest.json', 'catalog.json.gz', 'thumbs.json']);
      assert.equal(full.length, 3 + 9);
      assert.ok(!full.some((n) => n.includes('deadbeef')));
      // The manifest inside is the same but for files.full (placeholders)
      const z = openZip(join(rel1, m1.files.full.name));
      const inner = JSON.parse(z.read('manifest.json').toString('utf8')) as Manifest;
      z.close();
      assert.deepEqual({ ...inner, files: { ...inner.files, full: m1.files.full } }, m1);
      assert.equal(inner.files.full.sha256, '0'.repeat(64));
      // The catalog is the slim snapshot
      const slim = JSON.parse(gunzipSync(readFileSync(join(rel1, 'catalog.json.gz'))).toString('utf8'));
      assert.equal('rawRecords' in slim, false);
      assert.ok(slim.blueprints.length > 0);
    });

    it('is deterministic: the same input twice gives the same bytes', () => {
      const again = buildRelease({ snapshotFile, thumbsDir: thumbs1, n: 1, outDir: join(root, 'rel1b') });
      for (const name of readdirSync(rel1)) assert.ok(readFileSync(join(rel1, name)).equals(readFileSync(join(root, 'rel1b', name))), name);
      assert.equal(again.assets.length, 4);
    });

    it('installs the full pack into an empty database and data folder', async () => {
      const data = scratch('data1');
      const r = await installPack({
        connection: conn, dataDir: data, thumbsDir: join(data, 'thumbs'),
        source: { kind: 'full', file: join(rel1, m1.files.full.name) },
      });
      assert.deepEqual(r, { status: 'installed', tag: m1.tag, gameLabel: LABEL, catalog: 'imported', thumbs: { total: 9, written: 9, removed: 0 } });
      assert.equal(files(join(data, 'thumbs')).length, 9);
      assert.equal(readFileSync(join(data, 'thumbs', 's', `${uuidOf(1)}.aaaaaaaa.avif`), 'utf8'), 'fake avif s 1 aaaaaaaa');
      assert.deepEqual(JSON.parse(readFileSync(join(data, 'thumbs', 'thumbs.json'), 'utf8')), Object.fromEntries(Object.entries(v1).map(([i, h]) => [uuidOf(Number(i)), h])));
      assert.equal(installedPack(data)?.tag, m1.tag);
      assert.equal(await count('blueprint'), 2);
      assert.equal(await count('raw_record'), 0);
      assert.equal(readdirSync(data).filter((f) => f.endsWith('.tmp')).length, 0);
    });

    it('builds a second release against the first: only the new pictures, the complete thumbs.json', () => {
      const r = buildRelease({ snapshotFile, thumbsDir: thumbs2, n: 2, previousDir: rel1, outDir: rel2 });
      assert.deepEqual(r.thumbs, { total: 9, added: 6 });
      m2 = parseManifest(JSON.parse(readFileSync(join(rel2, 'manifest.json'), 'utf8')));
      assert.equal(m2.previous, m1.tag);
      assert.equal(m2.tag, `data-${LABEL}-2`);
      assert.equal(m2.files.thumbs.count, 6);
      const entries = names(join(rel2, 'thumbs-update.zip'));
      assert.deepEqual(entries.sort(), [
        'thumbs.json',
        ...SIZES.flatMap((s) => [`${s}/${uuidOf(3)}.c3c3c3c3.avif`, `${s}/${uuidOf(4)}.dddddddd.avif`]),
      ].sort());
      const z = openZip(join(rel2, 'thumbs-update.zip'));
      assert.deepEqual(Object.keys(JSON.parse(z.read('thumbs.json').toString('utf8'))), [uuidOf(1), uuidOf(3), uuidOf(4)]);
      z.close();
    });

    it('refuses to build with its own tag as predecessor', () => {
      assert.throws(() => buildRelease({ snapshotFile, thumbsDir: thumbs1, n: 1, previousDir: rel1, outDir: join(root, 'rel-x') }), /higher n/);
    });

    it('installs the update from its parts over the first: removed and replaced pictures are gone, the rest stays', async () => {
      const data = scratch('data1');
      const before = files(join(data, 'thumbs'));
      const keepStat = readFileSync(join(data, 'thumbs', 'm', `${uuidOf(1)}.aaaaaaaa.avif`));
      const r = await installPack({
        connection: conn, dataDir: data, thumbsDir: join(data, 'thumbs'),
        source: {
          kind: 'parts', manifest: JSON.parse(readFileSync(join(rel2, 'manifest.json'), 'utf8')),
          catalog: join(rel2, 'catalog.json.gz'), thumbsUpdates: [join(rel2, 'thumbs-update.zip')],
        },
      });
      assert.deepEqual(r, { status: 'installed', tag: m2.tag, gameLabel: LABEL, catalog: 'unchanged', thumbs: { total: 9, written: 6, removed: 6 } });
      const after = files(join(data, 'thumbs'));
      assert.deepEqual(after.filter((f) => !before.includes(f)), SIZES.flatMap((s) => [`${s}/${uuidOf(3)}.c3c3c3c3.avif`, `${s}/${uuidOf(4)}.dddddddd.avif`]).sort());
      assert.deepEqual(before.filter((f) => !after.includes(f)), SIZES.flatMap((s) => [`${s}/${uuidOf(2)}.bbbbbbbb.avif`, `${s}/${uuidOf(3)}.cccccccc.avif`]).sort());
      assert.ok(readFileSync(join(data, 'thumbs', 'm', `${uuidOf(1)}.aaaaaaaa.avif`)).equals(keepStat));
      assert.equal(installedPack(data)?.tag, m2.tag);
      assert.equal(installedPack(data)?.previous, m1.tag);
    });

    it('refuses an update whose earlier pictures are not there (a missing link of the chain), touching nothing', async () => {
      const data = scratch('data-gap');
      await assert.rejects(installPack({
        connection: conn, dataDir: data, thumbsDir: join(data, 'thumbs'),
        source: { kind: 'parts', manifest: JSON.parse(readFileSync(join(rel2, 'manifest.json'), 'utf8')), catalog: join(rel2, 'catalog.json.gz'), thumbsUpdates: [join(rel2, 'thumbs-update.zip')] },
      }), (e: unknown) => e instanceof DataPackError && e.code === 'incomplete');
      assert.equal(existsSync(join(data, 'thumbs')), false);
      assert.equal(installedPack(data), null);
    });

    it('installs a chain: the first update then the second, from an empty folder', async () => {
      const data = scratch('data-chain');
      await installPack({
        connection: conn, dataDir: data, thumbsDir: join(data, 'thumbs'),
        source: {
          kind: 'parts', manifest: JSON.parse(readFileSync(join(rel2, 'manifest.json'), 'utf8')), catalog: join(rel2, 'catalog.json.gz'),
          thumbsUpdates: [join(rel1, 'thumbs-update.zip'), join(rel2, 'thumbs-update.zip')],
        },
      });
      assert.equal(files(join(data, 'thumbs')).length, 9);
      assert.equal(existsSync(join(data, 'thumbs', 's', `${uuidOf(2)}.bbbbbbbb.avif`)), false);
    });

    it('refuses: wrong checksum, unknown format, a ZIP entry with ../, nothing touched', async () => {
      const manifest = JSON.parse(readFileSync(join(rel1, 'manifest.json'), 'utf8'));
      const data = scratch('data-refuse');
      const attempt = (source: Parameters<typeof installPack>[0]['source']) =>
        installPack({ connection: conn, dataDir: data, thumbsDir: join(data, 'thumbs'), source });
      const untouched = () => { assert.equal(existsSync(join(data, 'thumbs')), false); assert.equal(installedPack(data), null); };

      // a catalog that is not the one the manifest describes
      const badCatalog = join(root, 'bad-catalog.json.gz');
      const c = Buffer.from(readFileSync(join(rel1, 'catalog.json.gz')));
      c[c.length - 12] = (c[c.length - 12]! + 1) & 0xff;
      writeFileSync(badCatalog, c);
      await assert.rejects(attempt({ kind: 'parts', manifest, catalog: badCatalog, thumbsUpdates: [join(rel1, 'thumbs-update.zip')] }),
        (e: unknown) => e instanceof DataPackError && e.code === 'checksum');
      // a thumbs update that is not the one the manifest describes
      const badUpdate = join(root, 'bad-update.zip');
      writeFileSync(badUpdate, zip([{ name: 'thumbs.json', data: Buffer.from('{}') }], ZIP_EPOCH));
      await assert.rejects(attempt({ kind: 'parts', manifest, catalog: join(rel1, 'catalog.json.gz'), thumbsUpdates: [badUpdate] }),
        (e: unknown) => e instanceof DataPackError && e.code === 'checksum');
      // unknown format
      await assert.rejects(attempt({ kind: 'parts', manifest: { ...manifest, format: 2 }, catalog: join(rel1, 'catalog.json.gz'), thumbsUpdates: [join(rel1, 'thumbs-update.zip')] }),
        (e: unknown) => e instanceof DataPackError && e.code === 'unknownFormat');
      // not a pack at all
      await assert.rejects(attempt({ kind: 'full', file: badCatalog }), (e: unknown) => e instanceof DataPackError && e.code === 'invalid');

      // a full pack with a traversing entry (and with names a pack never has)
      const src = openZip(join(rel1, m1.files.full.name));
      const entries = src.entries.map((e) => ({ name: e.name, data: src.read(e.name) }));
      src.close();
      for (const [name, pattern] of [['../evil.txt', /unsafe/], ['readme.txt', /unexpected entry/], ['s\\x.avif', /unsafe/]] as const) {
        const evil = join(root, 'evil-pack.zip');
        writeFileSync(evil, zip([...entries, { name, data: Buffer.from('x') }], ZIP_EPOCH));
        await assert.rejects(attempt({ kind: 'full', file: evil }), (e: unknown) => e instanceof DataPackError && pattern.test(e.message), name);
      }
      untouched();
    });

    it('a pack with another catalog schema is appTooOld, nothing touched', async () => {
      const manifest = { ...JSON.parse(readFileSync(join(rel1, 'manifest.json'), 'utf8')), schemaVersion: 9 };
      const data = scratch('data-old');
      const r = await installPack({
        connection: conn, dataDir: data, thumbsDir: join(data, 'thumbs'),
        source: { kind: 'parts', manifest, catalog: join(rel1, 'catalog.json.gz'), thumbsUpdates: [join(rel1, 'thumbs-update.zip')] },
      });
      assert.deepEqual(r, { status: 'appTooOld', tag: m1.tag, packSchemaVersion: 9, appSchemaVersion: 8 });
      assert.equal(existsSync(join(data, 'thumbs')), false);
      assert.equal(installedPack(data), null);
    });

    it('a picture named by thumbs.json but missing at build time is an error naming it', () => {
      const broken = makeThumbs('thumbs-broken', v1);
      rmSync(join(broken, 'm', `${uuidOf(2)}.bbbbbbbb.avif`));
      assert.throws(() => buildRelease({ snapshotFile, thumbsDir: broken, n: 1, outDir: join(root, 'rel-broken') }),
        new RegExp(`m/${uuidOf(2)}\\.bbbbbbbb\\.avif`));
    });

    it('an interrupted install (pictures written, data-pack.json not) is completed by running it again', async () => {
      const data = scratch('data-interrupted');
      const full = { kind: 'full', file: join(rel1, m1.files.full.name) } as const;
      await installPack({ connection: conn, dataDir: data, thumbsDir: join(data, 'thumbs'), source: full });
      // The state after a crash between the pictures and the manifest, plus a half-written picture and a lost one
      rmSync(join(data, INSTALLED_FILE));
      writeFileSync(join(data, 'thumbs', 's', 'half.avif.tmp'), 'half');
      rmSync(join(data, 'thumbs', 'l', `${uuidOf(2)}.bbbbbbbb.avif`));
      assert.equal(installedPack(data), null);
      const r = await installPack({ connection: conn, dataDir: data, thumbsDir: join(data, 'thumbs'), source: full });
      assert.equal(r.status, 'installed');
      assert.equal(installedPack(data)?.tag, m1.tag);
      assert.equal(files(join(data, 'thumbs')).length, 9);
      assert.equal(existsSync(join(data, 'thumbs', 's', 'half.avif.tmp')), false);
      // And once more: idempotent
      const again = await installPack({ connection: conn, dataDir: data, thumbsDir: join(data, 'thumbs'), source: full });
      assert.deepEqual(again.status === 'installed' && again.thumbs, { total: 9, written: 0, removed: 0 });
    });

    it('installedPack is null for no file and for garbage', () => {
      const data = scratch('data-none');
      assert.equal(installedPack(data), null);
      writeFileSync(join(data, INSTALLED_FILE), '{ not json');
      assert.equal(installedPack(data), null);
    });
  });
});
