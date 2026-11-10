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
// Outposts (has_freight_elevator, set by the extractor): with the freight elevator amenity, without it, hidden with it (like the Onyx facilities), hidden but listed by key
const [OUTPOST_FE, OUTPOST, HIDDEN_FE, LISTED] = ['10000000-0000-0000-0000-0000000000bc', '10000000-0000-0000-0000-0000000000bd', '10000000-0000-0000-0000-0000000000be', '10000000-0000-0000-0000-0000000000bf'];
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
    for (const [uuid, key, hidden, freightElevator] of [
      [OUTPOST_FE, 'Test_Outpost_FE', false, true], [OUTPOST, 'Test_Outpost', false, false], [HIDDEN_FE, 'Test_Hidden_FE', true, true], [LISTED, 'Nyx_Kaboos', true, false],
    ] as const) {
      await db.execute(sql`INSERT INTO catalog.location (uuid, key, name_key, type, nav_icon, hide_in_starmap, has_freight_elevator, content_hash, first_seen_import_id, last_seen_import_id)
        VALUES (${uuid}, ${key}, 'test_station', 'Outpost', 'Outpost', ${hidden}, ${freightElevator}, 'x', 1, 1)`);
    }
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
    await refineStart(db, mia, { locationUuid: U.station, rows: [{ resourceUuid: U.metal, quality: 600, amount: '8' }] });
  });
  after(async () => close?.());

  it('offers selectable locations only, labelled with their place in the star map', async () => {
    const locations = await locationCatalog(db, 'en');
    // Stations, places with a freight elevator (amenity or listed key); not jump points, not hidden or plain outposts
    assert.deepEqual([...locations.keys()].sort(), [U.station, OUTPOST_FE, LISTED].sort());
    assert.equal(locations.get(U.station)!.label, 'Test Station');
    assert.equal(locations.get(LISTED)!.key, 'Nyx_Kaboos');
    assert.deepEqual((await locationChoices(db, 'en', 'test')).map((c) => c.value).sort(), [U.station, OUTPOST_FE, LISTED].sort());
  });

  it('offers recipe materials with their unit and ship components by type, never ores', async () => {
    const materials = await materialCatalog(db, 'en');
    // The fixture's blueprint output is a cooler: a component by its type, bookable although no recipe uses it
    assert.deepEqual([...materials.values()].map((m) => [m.uuid, m.kind, m.component]).sort(), [
      [U.metal, 'resource', false], [U.gem, 'item', false], [U.output, 'item', true],
    ].sort());
    // /qm-res offers the materials and items, /qm-gear the components by their label
    const regular = await materialChoices(db, 'de', '');
    assert.deepEqual(regular.map((c) => c.value).sort(), [`item:${U.gem}`, `resource:${U.metal}`].sort());
    assert.ok(regular.some((c) => c.name === 'Testmetall (SCU)'));
    assert.ok(regular.some((c) => c.name.endsWith('(Stk.)')));
    assert.deepEqual(await materialChoices(db, 'en', '', true), [{ name: 'Test Cooler · Cooler · S2 · B Military', value: `item:${U.output}` }]);
  });

  it('everyone picks their own batches, shared or not; material, then best quality first', async () => {
    const own = await pickableBatches(db, mia, 'change', 'en');
    const expected = own.map((p) => [p.material, p.batch.quality] as const)
      .toSorted((a, b) => a[0].localeCompare(b[0]) || b[1] - a[1]);
    assert.deepEqual(own.map((p) => [p.material, p.batch.quality]), expected);
    assert.equal(own.length, 5);
    assert.ok(own.every((p) => p.batch.ownerUserId === MIA));
    assert.deepEqual(own.filter((p) => p.batch.resourceUuid === U.metal && p.batch.state === 'stored').map((p) => [p.batch.quality, p.sharedIn]),
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
    assert.equal(batchLabel(job!, 'de'), '⚗️ Testmetall · Q600 · 8 SCU · Test Station · Pers.');
    const found = await batchChoices(db, mia, 'change', 'en', 'q900');
    assert.deepEqual(found.map((c) => c.name), ['Test Metal · Q900 · 1.5 SCU · Test Station · Pers.']);
  });
});
