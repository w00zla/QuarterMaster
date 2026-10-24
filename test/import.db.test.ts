// Runs against TEST_DATABASE_URL only; the web, bot, app and catalog schemas there are dropped and recreated.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { sql } from 'drizzle-orm';
import { type Db } from '../src/db/client.ts';
import { connectAs, prepareDb } from './roles.ts';
import { runImport, type ImportOptions } from '../src/catalog/import/apply.ts';
import { parseIniFile, runLocImport, runLocRemove, type LocImportOptions } from '../src/catalog/import/loc-import.ts';
import { loadPlannerData } from '../src/planner/load.ts';
import { getBlueprints } from '../src/adminapp/queries.ts';
import { sha256, stableStringify } from '../src/catalog/import/plan.ts';
import type { Snapshot } from '../src/catalog/snapshot.ts';
import { U, fixtureSnapshot } from './fixtures.ts';

const url = process.env.TEST_DATABASE_URL;
const OPTIONS: ImportOptions = { dryRun: false, force: false, allowDowngrade: false, maxRetireRatio: 0.1, maxChangeRatio: 0.5 };
const hashOf = (s: Snapshot) => sha256(stableStringify(s));

describe('catalog import (database)', { skip: url ? false : 'TEST_DATABASE_URL not set' }, () => {
  let db: Db;
  let close: () => Promise<void>;

  const count = async (table: string, where = 'true') =>
    Number((await db.execute<{ n: string }>(sql.raw(`SELECT count(*)::text AS n FROM catalog.${table} WHERE ${where}`)))[0]!.n);

  before(async () => {
    await prepareDb(url);
    ({ db, close } = connectAs(url, 'qm_app'));
  });
  after(async () => close?.());

  const base = fixtureSnapshot();

  it('dry run writes nothing', async () => {
    const r = await runImport(db, base, hashOf(base), { ...OPTIONS, dryRun: true });
    assert.equal(r.status, 'dry-run');
    assert.equal(r.diffs.blueprint.added.length, 2);
    assert.equal(await count('import'), 0);
    assert.equal(await count('blueprint'), 0);
  });

  it('imports a fresh snapshot completely', async () => {
    const r = await runImport(db, base, hashOf(base), OPTIONS);
    assert.equal(r.status, 'imported');
    assert.equal(await count('blueprint'), 2);
    assert.equal(await count('blueprint_slot'), 3);
    assert.equal(await count('blueprint_input'), 2);
    assert.equal(await count('resource'), 2);
    assert.equal(await count('raw_record'), base.rawRecords.length);
    assert.equal(await count('localization', `source = 'game' AND lang = 'de'`), 1);
    assert.equal(await count('localization', `source = 'game' AND lang = 'en'`), 7);
    assert.equal(await count('location'), 4);
    const [station] = await db.execute<{ parent: string; nav: string }>(
      sql`SELECT parent_uuid AS parent, nav_icon AS nav FROM catalog.location WHERE uuid = ${U.station}`);
    assert.deepEqual([station!.parent, station!.nav], [U.star, 'Station']);
    assert.equal(await count('localization_source', `source = 'game'`), 2);
    const [qty] = await db.execute<{ quantity: string }>(sql`SELECT quantity::text FROM catalog.blueprint_input WHERE kind = 'resource'`);
    assert.equal(qty!.quantity, '0.046');
    // Blueprint sources, numbered per blueprint
    const sources = await db.execute<{ i: number; kind: string; chance: string | null; systems: string[]; event: string }>(sql`
      SELECT source_index AS i, kind, chance::text, locality_uuids AS systems, event_key AS event
      FROM catalog.blueprint_source WHERE blueprint_uuid = ${U.blueprint2} ORDER BY source_index`);
    assert.deepEqual(sources.map((s) => [s.i, s.kind, s.chance, s.systems, s.event]), [
      [0, 'event', null, [], 'TestEvent'], [1, 'mission', '0.5', [U.star], 'Test'],
    ]);
    // Mining: the provider with its places, what it yields per method
    assert.equal(await count('mining_provider'), 1);
    const mined = await db.execute<{ method: string; scale: string; share: string; item: string | null; qmin: number | null; values: unknown }>(sql`
      SELECT method, quality_scale::text AS scale, share::text, item_uuid AS item, quality_min AS qmin, quality_values AS values
      FROM catalog.mineable ORDER BY method, quality_scale DESC`);
    assert.deepEqual(mined.map((m) => [m.method, m.scale, m.share, m.item, m.qmin, m.values]), [
      ['fps', '1', '1', U.gem, null, []],
      ['ship', '1', '0.875', null, 400, [{ value: 400, chance: 1 }]],
      ['ship', '0.49', '0.75', null, 400, [{ value: 400, chance: 1 }]],
    ]);
  });

  it('skips an identical snapshot', async () => {
    const r = await runImport(db, base, hashOf(base), OPTIONS);
    assert.equal(r.status, 'noop');
    assert.equal(await count('import'), 1);
  });

  it('updates changed recipes and retires missing entries, then revives them', async () => {
    const next = fixtureSnapshot();
    next.game.build = 1001;
    next.blueprints = next.blueprints.filter((b) => b.uuid !== U.blueprint2);
    next.blueprints[0]!.tiers[0]!.slots[0]!.inputs[0]!.quantity = 0.05;
    next.locations = next.locations.filter((l) => l.uuid !== U.orphan);
    next.blueprintSources = next.blueprintSources.filter((s) => s.kind === 'mission');
    next.mineables = next.mineables.filter((m) => m.method === 'ship');
    // Small sets: retiring 1 of 2 blueprints must not trip the ratio safeguard (absolute minimum)
    const r = await runImport(db, next, hashOf(next), OPTIONS);
    assert.equal(r.status, 'imported');
    assert.deepEqual([r.diffs.blueprint.changed, r.diffs.blueprint.retired], [[U.blueprint], [U.blueprint2]]);
    assert.equal(await count('blueprint', 'retired_at IS NOT NULL'), 1);
    assert.equal(await count('blueprint_input', `quantity = 0.05`), 1);
    assert.deepEqual(r.diffs.location.retired, [U.orphan]);
    assert.equal(await count('location', 'retired_at IS NOT NULL'), 1);
    // Sources and mining data are replaced as a whole
    assert.equal(await count('blueprint_source'), 1);
    assert.equal(await count('mineable'), 2);

    const again = fixtureSnapshot();
    again.game.build = 1002;
    const r2 = await runImport(db, again, hashOf(again), OPTIONS);
    assert.deepEqual(r2.diffs.blueprint.revived, [U.blueprint2]);
    assert.deepEqual(r2.diffs.location.revived, [U.orphan]);
    assert.equal(await count('blueprint', 'retired_at IS NULL'), 2);
    const [first] = await db.execute<{ first: number }>(sql`SELECT first_seen_import_id AS first FROM catalog.blueprint WHERE uuid = ${U.blueprint2}`);
    assert.equal(first!.first, r.importId! - 1);
  });

  it('blocks downgrades without writing', async () => {
    const old = fixtureSnapshot();
    old.game.build = 900;
    old.blueprints.pop();
    const before = await count('import');
    const r = await runImport(db, old, hashOf(old), OPTIONS);
    assert.equal(r.status, 'blocked');
    assert.deepEqual(r.safeguards.violations.map((v) => v.code), ['downgrade']);
    assert.equal(await count('import'), before);
    assert.equal(await count('blueprint', 'retired_at IS NULL'), 2);
  });

  it('seeds app-defined blueprint category names and falls back to the key', async () => {
    assert.equal(await count('localization', `source = 'app' AND lang = 'de'`), 24);
    assert.equal(await count('localization', `source = 'app' AND key NOT LIKE 'qm\\_%'`), 0);
    assert.equal(await count('localization_source', `source = 'app' AND key_count = 24`), 2);
    const [row] = await db.execute<{ value: string }>(sql`
      SELECT value FROM catalog.localization_effective WHERE lang = 'de' AND key = 'qm_blueprint_category_fpsarmours'`);
    assert.equal(row!.value, 'Rüstung');
    // The fixture's category has no manual text: derived from its key
    const bp = (await getBlueprints(db, 'de')).find((b) => b.uuid === U.blueprint)!;
    assert.deepEqual([bp.category, bp.categoryGroup, bp.categoryLabel], ['TestCat', 'TestCat', 'Test Cat']);
    // No game text for the fixture's item type: derived from the type
    assert.equal(bp.outputTypeLabel, 'Cooler');
    // Class from the item, named by the app's texts
    assert.deepEqual([bp.gradeLetter, bp.itemClass], ['B', 'Militär']);
  });

  it('loads planner recipes with names, inputs and modifiers', async () => {
    const data = await loadPlannerData(db, [U.blueprint, '00000000-0000-0000-0000-000000000000'], 'en');
    assert.equal(data.defaultQuality, 500);
    assert.equal(data.recipes.length, 1);
    const r = data.recipes[0]!;
    assert.deepEqual([r.name, r.craftSeconds, r.requiredSlots], ['Test Cooler', 150, 2]);
    assert.deepEqual(r.slots.map((s) => [s.key, s.name, s.inputs.map((i) => `${i.name} ${i.quantity}`)]), [
      ['FRAME', 'Frame', ['Test Metal 0.046']],
      ['EMITTER', 'Emitter', ['TEST_Gem 7']],
      ['NESTED', 'Nested', []],
    ]);
    assert.deepEqual(r.slots[0]!.modifiers.map((m) => [m.key, m.ranges.length]), [['GPP_Test', 2]]);
  });

  describe('external localization', () => {
    const LOC: LocImportOptions = {
      source: 'community-de', lang: 'de', priority: null, origin: 'test.ini', dryRun: false, force: false, maxRemoveRatio: 0.5, minGameOverlap: 0.5,
    };
    const effective = async (key: string) => (await db.execute<{ value: string; source: string }>(
      sql`SELECT value, source FROM catalog.localization_effective WHERE lang = 'de' AND key = ${key}`))[0];
    const ini = (text: string) => parseIniFile(new TextEncoder().encode(text)).texts;
    const file = ini('\uFEFFitems_commodities_testmetal=Gemeinschaftsmetall\r\nitem_NameTEST_Output=Testkühler\r\n'
      + 'items_commodities_testmetal_ore=Testerz\r\ncrafting_ui_slotname_frame=Rahmen\r\n');

    it('adds a source that wins over the game texts', async () => {
      const r = await runLocImport(db, file, LOC);
      assert.equal(r.status, 'imported');
      assert.equal(r.priority, 100);
      assert.equal(r.knownToGame, 4);
      assert.equal(r.wins, 4);
      assert.deepEqual(await effective('items_commodities_testmetal'), { value: 'Gemeinschaftsmetall', source: 'community-de' });
    });

    it('falls back to the game when the source has lower priority, and skips identical re-imports', async () => {
      assert.equal((await runLocImport(db, file, LOC)).status, 'noop');
      const r = await runLocImport(db, file, { ...LOC, priority: -1 });
      assert.equal(r.status, 'imported');
      assert.equal(r.wins, 3);
      assert.deepEqual(await effective('items_commodities_testmetal'), { value: 'Testmetall', source: 'game' });
    });

    it('survives a catalog import untouched', async () => {
      const next = fixtureSnapshot();
      next.game.build = 1003;
      next.localization.de!['items_commodities_testmetal'] = 'Testmetall neu';
      // Languages other than de/en are skipped (older snapshots carry them)
      next.localization.fr = { items_commodities_testmetal: 'Métal' };
      const r = await runImport(db, next, hashOf(next), OPTIONS);
      assert.deepEqual(r.localization.de && [r.localization.de.changed.length, r.localization.de.removed.length], [1, 0]);
      assert.equal(await count('localization', `source = 'community-de'`), 4);
      assert.equal(await count('localization_source', `lang = 'fr'`), 0);
    });

    it('blocks wrong files and mass removal', async () => {
      const wrong = await runLocImport(db, ini('a=1\r\nb=2\r\nc=3\r\n'), { ...LOC, source: 'other' });
      assert.deepEqual(wrong.violations.map((v) => v.code), ['low_overlap']);
      const shrunk = await runLocImport(db, ini('crafting_ui_slotname_frame=Rahmen\r\n'), LOC);
      assert.deepEqual(shrunk.violations.map((v) => v.code), ['mass_remove']);
      assert.equal(await count('localization', `source = 'community-de'`), 4);
      assert.equal(await count('localization_source', `source = 'other'`), 0);
    });

    it('rejects the reserved game source and removes a source with its texts', async () => {
      await assert.rejects(runLocImport(db, file, { ...LOC, source: 'game' }), /reserved/);
      await assert.rejects(runLocImport(db, file, { ...LOC, source: 'app' }), /reserved/);
      await assert.rejects(runLocImport(db, file, { ...LOC, lang: 'fr' }), /unsupported language/);
      await assert.rejects(runLocImport(db, { ...file, qm_blueprint_category_x: 'Hijack' }, LOC), /reserved for the app/);
      const parsed = parseIniFile(new TextEncoder().encode('qm_blueprint_category_x=Hijack\r\nitems_commodities_testmetal=Metall\r\n'));
      assert.deepEqual([Object.keys(parsed.texts), parsed.appKeys], [['items_commodities_testmetal'], 1]);
      assert.equal((await runLocRemove(db, 'community-de', 'de', true))?.keyCount, 4);
      assert.equal(await count('localization', `source = 'community-de'`), 4);
      await runLocRemove(db, 'community-de', 'de', false);
      assert.equal(await count('localization', `source = 'community-de'`), 0);
      assert.equal(await runLocRemove(db, 'community-de', 'de', false), null);
    });
  });
});
