// Runs against TEST_DATABASE_URL only; the web, bot, app and catalog schemas there are dropped and recreated.
// Gear: ship components (blueprint outputs and looted ones) and FPS gear, booked without quality.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { sql } from 'drizzle-orm';
import { type Db } from '../src/db/client.ts';
import { connectAs, prepareDb } from './roles.ts';
import { runImport } from '../src/catalog/import/apply.ts';
import { sha256, stableStringify } from '../src/catalog/import/plan.ts';
import { syncMember } from '../src/bot/roster.ts';
import { ensureGuild, updateGuildSettings } from '../src/bot/settings.ts';
import { formatAmount } from '../src/stock/amount.ts';
import { blueprintStatNames, materialCatalog, stockList } from '../src/stock/lookup.ts';
import { orgMetrics } from '../src/stock/org-summary.ts';
import { add, adjust, COMPONENT_QUALITY, StockError, type Actor } from '../src/stock/service.ts';
import { FPS, FPS_RECORDS, RECORDS, SHOP, SHOP_RECORDS, U, fixtureSnapshot } from './fixtures.ts';

const url = process.env.TEST_DATABASE_URL;
const G = '940000000000000001';
const MEMBER_ROLE = '941000000000000001';
const MIA = '942000000000000001';
const mia: Actor = { userId: MIA, guildId: G, source: 'webapp' };
// The name the component's stat has in the material catalog (the same crafted property)
const materialsStatName = (materials: Awaited<ReturnType<typeof materialCatalog>>) => materials.get(U.output)!.stats[0]!.name;

describe('ship components in stock (database)', { skip: url ? false : 'TEST_DATABASE_URL not set' }, () => {
  let db: Db;
  let close: () => Promise<void>;

  before(async () => {
    await prepareDb(url);
    ({ db, close } = connectAs(url, 'qm_app'));
    const snap = fixtureSnapshot({ ...RECORDS, ...FPS_RECORDS, ...SHOP_RECORDS });
    await runImport(db, snap, sha256(stableStringify(snap)), { dryRun: false, force: false, allowDowngrade: false, maxRetireRatio: 0.1, maxChangeRatio: 0.5 });
    // The fixture's blueprint (output: a cooler) becomes a ship component blueprint
    await db.execute(sql`UPDATE catalog.blueprint_category SET key = 'VehicleComponentS2' WHERE uuid = ${U.category}`);
    // Its stat as on a real cooler: multipliers 0.8–1.2 in one slot (the fixture mixes range types)
    const ranges = [
      { type: 'Linear', startQuality: 0, endQuality: 500, values: { modifierAtStart: 0.8, modifierAtEnd: 1 } },
      { type: 'Linear', startQuality: 501, endQuality: 1000, values: { modifierAtStart: 1, modifierAtEnd: 1.2 } },
    ];
    // in its first slot only (the other slots modify nothing)
    await db.execute(sql`UPDATE catalog.blueprint_slot SET modifiers = CASE WHEN slot_index = 0 AND tier_index = 0
        THEN ${JSON.stringify([{ propertyUuid: U.property, ranges }])}::jsonb ELSE '[]'::jsonb END
      WHERE blueprint_uuid IN (SELECT uuid FROM catalog.blueprint WHERE output_item_uuid = ${U.output})`);
    // Its property stands for Integrity, whose base value sits in the record's health component
    await db.execute(sql`UPDATE catalog.crafted_property SET key = 'GPP_Health_MaxHealth' WHERE uuid = ${U.property}`);
    await db.execute(sql`UPDATE catalog.raw_record SET data = jsonb_set(data, '{Components}', data->'Components' || '[{"_Type_": "SHealthComponentParams", "Health": 110}]'::jsonb)
      WHERE uuid = ${U.output}`);
    await ensureGuild(db, G, 'Component Org');
    const settings = await updateGuildSettings(db, G, { memberRoleIds: [MEMBER_ROLE] });
    await syncMember(db, G, settings, MIA, { userId: MIA, displayName: 'Mia', roleIds: [MEMBER_ROLE], bot: false });
  });
  after(async () => close?.());

  it('offers the outputs of component blueprints as components, with a unique label', async () => {
    const materials = await materialCatalog(db, 'en');
    const cooler = materials.get(U.output)!;
    assert.equal(cooler.kind, 'item');
    assert.equal(cooler.component, true);
    assert.equal(cooler.label, 'Test Cooler · Cooler · S2 · B Military');
    assert.equal(materials.get(U.gem)!.component, false);
    assert.equal(materials.get(U.metal)!.component, false);
  });

  it('keeps the shop items (clothing, food, ...) in the catalog but out of the material catalog and the stock', async () => {
    const [shop] = await db.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM catalog.item WHERE uuid IN (${FPS.jacket}, ${SHOP.food}, ${SHOP.miscCarry}, ${SHOP.blade})`);
    assert.equal(shop?.n, 4);
    const materials = await materialCatalog(db, 'en');
    for (const u of [FPS.jacket, FPS.magazine, FPS.grenade, SHOP.food, SHOP.miscCarry, SHOP.blade]) assert.equal(materials.has(u), false, u);
    await assert.rejects(add(db, mia, { kind: 'item', uuid: SHOP.food, locationUuid: U.station, quality: COMPONENT_QUALITY, amount: '1' }),
      (e: unknown) => e instanceof StockError && e.code === 'notBookable');
  });

  it('books components with the fixed quality only', async () => {
    const cooler = { kind: 'item' as const, uuid: U.output, locationUuid: U.station, amount: '2' };
    await assert.rejects(add(db, mia, { ...cooler, quality: 500 }), (e: unknown) => e instanceof StockError && e.code === 'invalidQuality');
    await assert.rejects(add(db, mia, { ...cooler, quality: COMPONENT_QUALITY, amount: '1.5' }), (e: unknown) => e instanceof StockError && e.code === 'invalidAmount');
    await add(db, mia, { ...cooler, quality: COMPONENT_QUALITY, org: true });
    await add(db, mia, { kind: 'item', uuid: U.gem, locationUuid: U.station, quality: 100, amount: '3', org: true });
    const list = await stockList(db, { scope: { personalOf: MIA } }, 'en');
    assert.deepEqual(list.map((p) => [p.batch.itemUuid, p.component, formatAmount(p.batch.quantity)]).sort(),
      [[U.gem, false, '3'], [U.output, true, '2']].sort());
  });

  it('offers the stats of the component blueprint with their bounds, nothing for other materials', async () => {
    const materials = await materialCatalog(db, 'en');
    assert.deepEqual(materials.get(U.output)!.stats.map(({ uuid, kind, min, max, nameKey, base, tooltip }) => ({ uuid, kind, min, max, nameKey, base, tooltip })),
      [{ uuid: U.property, kind: 'multiplier', min: 0, max: 20, nameKey: 'statname_gpp_test', base: 110, tooltip: 'value' }]);
    assert.deepEqual(materials.get(U.gem)!.stats, []);
  });

  it('names the stats a blueprint can change; blueprints without any are missing', async () => {
    const names = await blueprintStatNames(db, 'en');
    assert.deepEqual(names.get(U.blueprint), [materialsStatName(await materialCatalog(db, 'en'))]);
    assert.equal(names.has(U.blueprint2), false);
  });

  it('keeps batches with other stats apart and merges the same stats, normalized', async () => {
    const cooler = { kind: 'item' as const, uuid: U.output, locationUuid: U.station, quality: COMPONENT_QUALITY };
    const statsOf = async () => (await stockList(db, { scope: { personalOf: MIA } }, 'en'))
      .filter((p) => p.component).map((p) => [p.batch.stats, formatAmount(p.batch.quantity)] as const)
      .toSorted((a, b) => JSON.stringify(a[0]).localeCompare(JSON.stringify(b[0])));
    const first = await add(db, mia, { ...cooler, amount: '1', stats: { [U.property]: '+5,0' } });
    assert.deepEqual(first.batch!.stats, { [U.property]: '5' });
    assert.deepEqual(first.journal[0]!.stats, { [U.property]: '5' });
    await add(db, mia, { ...cooler, amount: '1', stats: { [U.property]: '5' } });
    await add(db, mia, { ...cooler, amount: '1', stats: { [U.property]: '12.5' } });
    // Empty values and no change count as none: the batch without stats from before
    await add(db, mia, { ...cooler, amount: '1', stats: { [U.property]: ' ' } });
    await add(db, mia, { ...cooler, amount: '1', stats: { [U.property]: '0' } });
    assert.deepEqual(await statsOf(), [[{ [U.property]: '12.5' }, '1'], [{ [U.property]: '5' }, '2'], [null, '4']]);
    const [row] = await db.execute<{ stats: unknown }>(sql`
      SELECT details->'stats' AS stats FROM app.history WHERE target_uuid = ${U.output} AND action = 'add' ORDER BY id DESC OFFSET 2 LIMIT 1`);
    assert.deepEqual(row!.stats, { [U.property]: '12.5' });
  });

  it('refuses stats a component cannot have, and stats on other materials', async () => {
    const cooler = { kind: 'item' as const, uuid: U.output, locationUuid: U.station, quality: COMPONENT_QUALITY, amount: '1' };
    const invalid = (e: unknown) => e instanceof StockError && e.code === 'invalidStats';
    await assert.rejects(add(db, mia, { ...cooler, stats: { [U.metal]: '1' } }), invalid);
    await assert.rejects(add(db, mia, { ...cooler, stats: { [U.property]: '5 %' } }), invalid);
    await assert.rejects(add(db, mia, { ...cooler, stats: { [U.property]: '20.1' } }), invalid);
    // Never worse than a looted one
    await assert.rejects(add(db, mia, { ...cooler, stats: { [U.property]: '-5' } }), invalid);
    await assert.rejects(add(db, mia, { ...cooler, stats: { [U.property]: '5.25' } }), invalid);
    await assert.rejects(add(db, mia, { kind: 'item', uuid: U.gem, locationUuid: U.station, quality: 100, amount: '1', stats: { [U.property]: '1' } }), invalid);
  });

  it('counts components apart from items', async () => {
    const m = (await orgMetrics(db, [G])).get(G)!;
    assert.deepEqual(m.items, { kinds: 1, pieces: '3', locations: 1 });
    // The shared batch without stats (2 + 2 later); the ones with stats are unshared
    assert.deepEqual(m.components, { kinds: 1, pieces: '4', locations: 1 });
  });

  it('adjust changes the stats: a new key keeps the shares, an existing one merges', async () => {
    const own = async () => (await stockList(db, { scope: { personalOf: MIA } }, 'en')).filter((p) => p.component);
    const of = async (stats: Record<string, string> | null) => (await own()).find((p) => JSON.stringify(p.batch.stats) === JSON.stringify(stats));
    // The shared batch without stats (4) gets stats it has nowhere else: it keeps its shares
    const plain = (await of(null))!;
    const changed = await adjust(db, mia, { batchId: plain.batch.id, amount: '4', expected: plain.batch.quantity, stats: { [U.property]: '7.5' } });
    assert.deepEqual(changed.batch!.stats, { [U.property]: '7.5' });
    assert.deepEqual(changed.journal.map((j) => [j.action, formatAmount(j.delta), j.stats]),
      [['move_out', '-4', null], ['move_in', '4', { [U.property]: '7.5' }]]);
    assert.deepEqual((await of({ [U.property]: '7.5' }))!.sharedIn, [G]);
    assert.equal(await of(null), undefined);
    const [row] = await db.execute<{ details: Record<string, unknown> }>(sql`
      SELECT details FROM app.history WHERE action = 'adjust' AND target_uuid = ${U.output} ORDER BY id DESC LIMIT 1`);
    assert.deepEqual([row!.details.stats, row!.details.statsFrom, row!.details.amount, row!.details.from],
      [{ [U.property]: '7.5' }, {}, '4', changed.batch!.quantity]);
    // Counted and changed at once, into the existing +5 % batch (2): it keeps its own (no) shares
    const moved = (await of({ [U.property]: '7.5' }))!;
    const merged = await adjust(db, mia, { batchId: moved.batch.id, amount: '3', expected: moved.batch.quantity, stats: { [U.property]: '5' } });
    assert.equal(formatAmount(merged.batch!.quantity), '5');
    assert.deepEqual(merged.journal.map((j) => j.action), ['adjust', 'move_out', 'move_in']);
    assert.deepEqual((await of({ [U.property]: '5' }))!.sharedIn, []);
    // Back to none ({}), nothing new, stats on other materials
    const five = (await of({ [U.property]: '5' }))!;
    await adjust(db, mia, { batchId: five.batch.id, amount: '5', expected: five.batch.quantity, stats: {} });
    assert.equal(formatAmount((await of(null))!.batch.quantity), '5');
    const none = (await of(null))!;
    await assert.rejects(adjust(db, mia, { batchId: none.batch.id, amount: '5', expected: none.batch.quantity, stats: {} }),
      (e: unknown) => e instanceof StockError && e.code === 'noChange');
    const gem = (await stockList(db, { scope: { personalOf: MIA } }, 'en')).find((p) => p.batch.itemUuid === U.gem)!;
    await assert.rejects(adjust(db, mia, { batchId: gem.batch.id, amount: '3', expected: gem.batch.quantity, stats: { [U.property]: '5' } }),
      (e: unknown) => e instanceof StockError && e.code === 'invalidStats');
  });

  it('offers FPS gear as gear with its sub type (attachments with their size), and books it like a component', async () => {
    const materials = await materialCatalog(db, 'en');
    // No texts in the fixture: the class name and the type keys stand in
    assert.deepEqual([FPS.rifle, FPS.helmet, FPS.optic].map((u) => [materials.get(u)!.component, materials.get(u)!.label, materials.get(u)!.size]), [
      [true, 'test_rifle · Weapon Personal · Medium', null],
      [true, 'test_helmet · Char Armor Helmet · Light', null],
      [true, 'test_optic · Weapon Attachment · Iron Sight · S2', 2],
    ]);
    await add(db, mia, { kind: 'item', uuid: FPS.rifle, locationUuid: U.station, quality: COMPONENT_QUALITY, amount: '1' });
    const rifle = (await stockList(db, { scope: { personalOf: MIA } }, 'en')).find((p) => p.batch.itemUuid === FPS.rifle)!;
    assert.equal(rifle.component, true);
  });
});
