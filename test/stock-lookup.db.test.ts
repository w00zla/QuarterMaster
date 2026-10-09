// Runs against TEST_DATABASE_URL only; the web, bot, app and catalog schemas there are dropped and recreated.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { sql } from 'drizzle-orm';
import { type Db } from '../src/db/client.ts';
import { connectAs, prepareDb } from './roles.ts';
import { runImport } from '../src/catalog/import/apply.ts';
import { sha256, stableStringify } from '../src/catalog/import/plan.ts';
import { batchChoices, batchLabel, locationChoices, materialChoices } from '../src/bot/pickers.ts';
import { syncMember } from '../src/bot/roster.ts';
import { ensureGuild, updateGuildSettings } from '../src/bot/settings.ts';
import { locationCatalog, materialCatalog, pickableBatches } from '../src/stock/lookup.ts';
import { add, refineStart, type Actor } from '../src/stock/service.ts';
import { U, fixtureSnapshot } from './fixtures.ts';

const url = process.env.TEST_DATABASE_URL;
const G = '930000000000000001';
const MEMBER_ROLE = '931000000000000001';
const [MIA, OLGA] = ['932000000000000001', '932000000000000002'];
const JUMP = '10000000-0000-0000-0000-0000000000bb';
const mia: Actor = { userId: MIA, guildId: G, source: 'bot' };
const olga: Actor = { userId: OLGA, guildId: G, source: 'bot' };

describe('stock lookups and pickers (database)', { skip: url ? false : 'TEST_DATABASE_URL not set' }, () => {
  let db: Db;
  let close: () => Promise<void>;

  before(async () => {
    await prepareDb(url);
    ({ db, close } = connectAs(url, 'qm_app'));
    const snap = fixtureSnapshot();
    await runImport(db, snap, sha256(stableStringify(snap)), { dryRun: false, force: false, allowDowngrade: false, maxRetireRatio: 0.1, maxChangeRatio: 0.5 });
    // A named jump point: a station by nav icon, but never a place to store things
    await db.execute(sql`INSERT INTO catalog.location (uuid, key, name_key, type, nav_icon, hide_in_starmap, content_hash, first_seen_import_id, last_seen_import_id)
      VALUES (${JUMP}, 'JumpPoint_Test', 'test_station', 'Anomaly', 'Station', false, 'x', 1, 1)`);
    await ensureGuild(db, G, 'Lookup Org');
    const settings = await updateGuildSettings(db, G, { memberRoleIds: [MEMBER_ROLE] });
    await syncMember(db, G, settings, MIA, { userId: MIA, displayName: 'Mia', roleIds: [MEMBER_ROLE], bot: false });
    await syncMember(db, G, settings, OLGA, { userId: OLGA, displayName: 'Olga', roleIds: [MEMBER_ROLE], bot: false });
    const metal = { kind: 'resource' as const, uuid: U.metal, locationUuid: U.station };
    await add(db, mia, { ...metal, quality: 500, amount: '2' });
    await add(db, mia, { ...metal, quality: 900, amount: '1,5' });
    await add(db, mia, { kind: 'item', uuid: U.gem, locationUuid: U.station, quality: 100, amount: '7' });
    await add(db, mia, { ...metal, quality: 700, amount: '4', org: true });
    await add(db, olga, { ...metal, quality: 800, amount: '3' });
    await refineStart(db, mia, { locationUuid: U.station, rows: [{ oreUuid: U.ore, quality: 600, amount: '8' }] });
  });
  after(async () => close?.());

  it('offers selectable locations only, labelled with their place in the star map', async () => {
    const locations = await locationCatalog(db, 'en');
    assert.deepEqual([...locations.keys()], [U.station]);
    assert.equal(locations.get(U.station)!.label, 'Test Station');
    assert.deepEqual(await locationChoices(db, 'en', 'test'), [{ name: 'Test Station', value: U.station }]);
  });

  it('offers recipe materials with their unit, ores only for the refinery', async () => {
    const materials = await materialCatalog(db, 'en');
    assert.deepEqual([...materials.values()].map((m) => [m.uuid, m.kind, m.isOre]).sort(), [
      [U.metal, 'resource', false], [U.ore, 'resource', true], [U.gem, 'item', false],
    ].sort());
    const regular = await materialChoices(db, 'de', '', false);
    assert.deepEqual(regular.map((c) => c.value).sort(), [`item:${U.gem}`, `resource:${U.metal}`].sort());
    assert.ok(regular.some((c) => c.name === 'Testmetall (SCU)'));
    assert.ok(regular.some((c) => c.name.endsWith('(Stk.)')));
    assert.deepEqual((await materialChoices(db, 'en', '', true)).map((c) => c.value), [U.ore]);
  });

  it('everyone picks their own batches, shared or not; material, then best quality first', async () => {
    const own = await pickableBatches(db, mia, 'change', 'en');
    const expected = own.map((p) => [p.material, p.batch.quality] as const)
      .toSorted((a, b) => a[0].localeCompare(b[0]) || b[1] - a[1]);
    assert.deepEqual(own.map((p) => [p.material, p.batch.quality]), expected);
    assert.equal(own.length, 5);
    assert.ok(own.every((p) => p.batch.ownerUserId === MIA));
    assert.deepEqual(own.filter((p) => p.batch.resourceUuid === U.metal).map((p) => [p.batch.quality, p.sharedIn]),
      [[900, []], [700, [G]], [500, []]]);
    // Mia's shared batch is hers alone to change
    assert.deepEqual((await pickableBatches(db, olga, 'change', 'en')).map((p) => [p.sharedIn, p.batch.quality]), [[[], 800]]);
    assert.deepEqual((await pickableBatches(db, mia, 'refining', 'en')).map((p) => p.batch.state), ['refining']);
    assert.ok((await pickableBatches(db, mia, 'move', 'en')).every((p) => p.batch.state === 'stored'));
  });

  it('labels batches for the picker', async () => {
    const [org] = (await pickableBatches(db, mia, 'change', 'en')).filter((p) => p.sharedIn.length);
    assert.equal(batchLabel(org!, 'en'), 'Test Metal · Q700 · 4 SCU · Test Station · Org (Mia)');
    const [job] = await pickableBatches(db, mia, 'refining', 'de');
    assert.equal(batchLabel(job!, 'de'), '⚗️ Test Metal (Ore) · Q600 · 8 SCU · Test Station · Pers.');
    const found = await batchChoices(db, mia, 'change', 'en', 'q900');
    assert.deepEqual(found.map((c) => c.name), ['Test Metal · Q900 · 1.5 SCU · Test Station · Pers.']);
  });
});
