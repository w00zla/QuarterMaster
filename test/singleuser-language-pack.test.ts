// The language pack as a localization source (src/singleuser/language-pack.ts): PGlite in memory, synthetic texts, the real
// routes of the web app as the singleuser variant builds them. No Postgres, no game folder.
//
// The catalog route keeps its texts per language until the next catalog import (importCache), so only the first
// phase reads it, right after the first sync, as a start does; the later phases read the routes that ask the database
// every time (`/api/info/...`).
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { sql } from 'drizzle-orm';
import { fileURLToPath } from 'node:url';
import { runImport } from '../src/catalog/import/apply.ts';
import { runLocImport, runLocRemove } from '../src/catalog/import/loc-import.ts';
import { locText } from '../src/db/query.ts';
import { PACK_PRIORITY, PACK_SOURCE } from '../src/catalog/import/localization.ts';
import { sha256, stableStringify } from '../src/catalog/import/plan.ts';
import { connectPglite } from '../src/db/pglite.ts';
import type { LanguagePack } from '../src/singleuser/game-folder.ts';
import { syncLanguagePack } from '../src/singleuser/language-pack.ts';
import type { CatalogResponse, MaterialInfo } from '../src/webapp/api-types.ts';
import { createApp } from '../src/webapp/app.ts';
import { localIdentity } from '../src/webapp/identity-local.ts';
import { U, fixtureSnapshot } from './fixtures.ts';

const ORIGIN = 'http://127.0.0.1:28460';
const IMPORT = { dryRun: false, force: true, allowDowngrade: true, maxRetireRatio: 1, maxChangeRatio: 1 };

const pack = (texts: Record<string, string>): LanguagePack => ({
  language: 'german_(germany)', file: 'C:/game/data/Localization/german_(germany)/global.ini', texts: new Map(Object.entries(texts)),
});

describe('language pack as a localization source (PGlite)', { timeout: 120_000 }, () => {
  const connection = connectPglite(null);
  const { db } = connection;
  let maintained = 0;
  const counting = { db, maintain: async () => { maintained++; await connection.maintain(); } };
  let app: ReturnType<typeof createApp>;

  const get = async <T>(path: string) => {
    const res = await app.request(`/api${path}`);
    assert.equal(res.status, 200, path);
    return (await res.json()) as T;
  };
  const material = (uuid: string, lang: string) => get<MaterialInfo>(`/info/material/${uuid}?lang=${lang}`);
  const sourceRow = async () => (await db.execute<{ sha: string; at: string; n: number; priority: number; origin: string }>(sql`
    SELECT content_sha256 AS sha, imported_at::text AS at, key_count AS n, priority, origin FROM catalog.localization_source
    WHERE source = ${PACK_SOURCE} AND lang = 'en'`))[0];
  const rows = async (source: string) => (await db.execute<{ lang: string; key: string; value: string; x: string }>(sql`
    SELECT lang, key, value, xmin::text AS x FROM catalog.localization WHERE source = ${source} ORDER BY lang, key`));
  const text = async (lang: string, key: string) => (await db.execute<{ value: string }>(sql`
    SELECT value FROM catalog.localization_effective WHERE lang = ${lang} AND key = ${key}`))[0]?.value;

  before(async () => {
    await connection.migrate(fileURLToPath(new URL('../drizzle', import.meta.url)));
    // As the data pack's snapshot: English game texts only
    const snap = fixtureSnapshot();
    delete snap.localization.de;
    assert.deepEqual(Object.keys(snap.localization), ['en']);
    await runImport(db, snap, sha256(stableStringify(snap)), IMPORT);
    app = createApp(db, await localIdentity(db), { origin: ORIGIN, trustProxy: false, distDir: null, capabilities: { login: 'none', orgs: false, uex: false } });
  });
  after(() => connection.close());

  const PACK_V1 = {
    items_commodities_testmetal: 'Testmetall',
    item_nametest_output: 'Testkühler',
    unrelated_key: 'Nicht referenziert',
    crafting_ui_slotname_frame: 'Rahmen',
  };

  it('stores a pack once under en, above the game and below the app; the catalog route shows it for lang=de and lang=en', async () => {
    assert.deepEqual(await syncLanguagePack(counting, pack(PACK_V1)), { outcome: 'written', texts: 4, added: 4, changed: 0, removed: 0 });
    assert.equal(maintained, 1);
    const row = (await sourceRow())!;
    assert.equal(row.priority, PACK_PRIORITY);
    assert.equal(row.n, 4);
    assert.equal(row.origin, 'C:/game/data/Localization/german_(germany)/global.ini');
    assert.deepEqual((await rows(PACK_SOURCE)).map((r) => r.lang), ['en', 'en', 'en', 'en']);

    for (const lang of ['de', 'en']) {
      const { materials, locations, blueprints } = await get<CatalogResponse>(`/catalog?lang=${lang}`);
      // Overridden: the pack's text; the game's English has "Test Metal" and "Test Cooler"
      assert.equal(materials.find((m) => m.uuid === U.metal)!.name, 'Testmetall', lang);
      assert.equal(materials.find((m) => m.uuid === U.output)!.name.trim(), 'Testkühler', lang);
      // Not in the pack: the game's English, whichever language asks
      assert.equal(locations.find((l) => l.uuid === U.station)!.label, 'Test Station', lang);
      assert.ok(blueprints.length > 0);
    }

    // The app's own texts (source `app`) keep following the UI language, through the app's own resolver
    const appText = async (lang: string) => (await db.execute<{ t: string }>(sql`SELECT ${locText(lang, sql`'qm_blueprint_category_fpsarmours'`)} AS t`))[0]!.t;
    assert.equal(await appText('de'), 'Rüstung');
    assert.equal(await appText('en'), 'Personal Armor');
    assert.equal(await sourceCount('app'), 2);
  });

  const sourceCount = async (source: string) => Number((await db.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM catalog.localization_source WHERE source = ${source}`))[0]!.n);

  it('the info routes agree: the pack where it has the key, the game\'s English where it lacks it, for both languages', async () => {
    for (const lang of ['de', 'en']) {
      assert.equal((await material(U.metal, lang)).name, 'Testmetall', lang);
      assert.equal((await material(U.output, lang)).name.trim(), 'Testkühler', lang);
    }
    // The station's name is not in the pack: the game's English
    assert.equal(await text('de', 'test_station'), undefined); // not stored under de ...
    assert.equal(await text('en', 'test_station'), 'Test Station'); // ... and the lookup falls back to this
  });

  it('the same file at the next start writes nothing', async () => {
    const [before, rowsBefore, made] = [(await sourceRow())!, await rows(PACK_SOURCE), maintained];
    assert.deepEqual(await syncLanguagePack(counting, pack(PACK_V1)), { outcome: 'unchanged', texts: 4 });
    assert.deepEqual(await sourceRow(), before); // imported_at included
    assert.deepEqual(await rows(PACK_SOURCE), rowsBefore); // xmin included: not one row was rewritten
    assert.equal(maintained, made);
  });

  it('a changed file writes only the changed texts', async () => {
    const before = await rows(PACK_SOURCE);
    const sourceBefore = (await sourceRow())!;
    const v2 = { ...PACK_V1, item_nametest_output: 'Prüfkühler', brand_new_key: 'Neu' } as Record<string, string>;
    delete v2.unrelated_key;
    assert.deepEqual(await syncLanguagePack(counting, pack(v2)), { outcome: 'written', texts: 4, added: 1, changed: 1, removed: 1 });
    assert.equal(maintained, 2);
    const after = await rows(PACK_SOURCE);
    assert.deepEqual(after.map((r) => r.key), ['brand_new_key', 'crafting_ui_slotname_frame', 'item_nametest_output', 'items_commodities_testmetal']);
    // The two texts that did not change are the same row versions
    for (const key of ['crafting_ui_slotname_frame', 'items_commodities_testmetal']) {
      assert.equal(after.find((r) => r.key === key)!.x, before.find((r) => r.key === key)!.x, key);
    }
    assert.notEqual(after.find((r) => r.key === 'item_nametest_output')!.x, before.find((r) => r.key === 'item_nametest_output')!.x);
    assert.notEqual((await sourceRow())!.sha, sourceBefore.sha);
    for (const lang of ['de', 'en']) assert.equal((await material(U.output, lang)).name.trim(), 'Prüfkühler', lang);
  });

  it('no pack, or an unusable one: the source is gone and the game\'s English is back', async () => {
    assert.deepEqual(await syncLanguagePack(counting, { language: 'german_(germany)', file: 'x', texts: null, problem: 'iniEmpty' }), { outcome: 'removed', texts: 4 });
    assert.equal(maintained, 3);
    assert.equal(await sourceCount(PACK_SOURCE), 0);
    assert.equal((await rows(PACK_SOURCE)).length, 0);
    for (const lang of ['de', 'en']) {
      assert.equal((await material(U.metal, lang)).name, 'Test Metal', lang);
      assert.equal((await material(U.output, lang)).name.trim(), 'Test Cooler', lang);
    }
    assert.deepEqual(await syncLanguagePack(counting, null), { outcome: 'none' });
    assert.equal(maintained, 3);
  });

  it('a catalog import (data pack install) leaves the source alone and the game texts it changes show where the pack lacks them', async () => {
    await syncLanguagePack(counting, pack(PACK_V1));
    const [source, packRows] = [(await sourceRow())!, await rows(PACK_SOURCE)];
    const snap = fixtureSnapshot();
    delete snap.localization.de;
    snap.localization.en!.test_station = 'Test Station 2';
    snap.localization.en!.items_commodities_testmetal = 'Test Metal 2';
    assert.equal((await runImport(db, snap, sha256(stableStringify(snap)), IMPORT)).status, 'imported');
    assert.deepEqual(await sourceRow(), source);
    assert.deepEqual(await rows(PACK_SOURCE), packRows);
    assert.equal(await text('en', 'test_station'), 'Test Station 2');
    assert.equal((await material(U.metal, 'de')).name, 'Testmetall');
  });

  it('loc:import refuses the reserved source name', async () => {
    const opts = { source: PACK_SOURCE, lang: 'en', priority: null, origin: 'x', dryRun: false, force: true, maxRemoveRatio: 1, minGameOverlap: 0 };
    await assert.rejects(runLocImport(db, { a: 'b' }, opts), /reserved/);
    await assert.rejects(runLocRemove(db, PACK_SOURCE, 'en', false), /reserved/);
    assert.equal(await sourceCount(PACK_SOURCE), 1);
  });
});
