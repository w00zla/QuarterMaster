// Runs against TEST_DATABASE_URL only; the web, bot, app and catalog schemas there are dropped and recreated.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { sql } from 'drizzle-orm';
import { type Db } from '../src/db/client.ts';
import { connectAs, prepareDb } from './roles.ts';
import { runImport } from '../src/catalog/import/apply.ts';
import { sha256, stableStringify } from '../src/catalog/import/plan.ts';
import { bookAdd, bookChange, bookShare, listLines } from '../src/bot/commands/stock.ts';
import { UserError } from '../src/bot/errors.ts';
import { syncMember } from '../src/bot/roster.ts';
import { ensureGuild, updateGuildSettings } from '../src/bot/settings.ts';
import { stockList } from '../src/stock/lookup.ts';
import { add, COMPONENT_QUALITY, type Actor } from '../src/stock/service.ts';
import { U, fixtureSnapshot } from './fixtures.ts';

const url = process.env.TEST_DATABASE_URL;
const G = '940000000000000001';
const G2 = '940000000000000002';
const MEMBER_ROLE = '941000000000000001';
const [MIA, OLGA] = ['942000000000000001', '942000000000000002'];
const mia: Actor = { userId: MIA, guildId: G, source: 'bot' };
const olga: Actor = { userId: OLGA, guildId: G, source: 'bot' };
const metal = { kind: 'resource' as const, uuid: U.metal, locationUuid: U.station };

describe('/qm-stock bookings and lists (database)', { skip: url ? false : 'TEST_DATABASE_URL not set' }, () => {
  let db: Db;
  let close: () => Promise<void>;

  before(async () => {
    await prepareDb(url);
    ({ db, close } = connectAs(url, 'qm_app'));
    const snap = fixtureSnapshot();
    await runImport(db, snap, sha256(stableStringify(snap)), { dryRun: false, force: false, allowDowngrade: false, maxRetireRatio: 0.1, maxChangeRatio: 0.5 });
    // The fixture's cooler gets a stat as on a real one: multipliers 0.8–1.2 in its blueprint's first slot
    const ranges = [
      { type: 'Linear', startQuality: 0, endQuality: 500, values: { modifierAtStart: 0.8, modifierAtEnd: 1 } },
      { type: 'Linear', startQuality: 501, endQuality: 1000, values: { modifierAtStart: 1, modifierAtEnd: 1.2 } },
    ];
    await db.execute(sql`UPDATE catalog.blueprint_slot SET modifiers = CASE WHEN slot_index = 0 AND tier_index = 0
        THEN ${JSON.stringify([{ propertyUuid: U.property, ranges }])}::jsonb ELSE '[]'::jsonb END
      WHERE blueprint_uuid IN (SELECT uuid FROM catalog.blueprint WHERE output_item_uuid = ${U.output})`);
    await ensureGuild(db, G, 'Stock Cmd Org');
    const settings = await updateGuildSettings(db, G, { memberRoleIds: [MEMBER_ROLE] });
    await syncMember(db, G, settings, MIA, { userId: MIA, displayName: 'Mia', roleIds: [MEMBER_ROLE], bot: false });
    await syncMember(db, G, settings, OLGA, { userId: OLGA, displayName: 'Olga', roleIds: [MEMBER_ROLE], bot: false });
    await ensureGuild(db, G2, 'Second Org');
    const settings2 = await updateGuildSettings(db, G2, { memberRoleIds: [MEMBER_ROLE] });
    await syncMember(db, G2, settings2, MIA, { userId: MIA, displayName: 'Mia', roleIds: [MEMBER_ROLE], bot: false });
  });
  after(async () => close?.());

  it('books removals from the modal and tells what is left', async () => {
    const b = (await add(db, mia, { ...metal, quality: 820, amount: '12,5' })).batch!;
    assert.equal(await bookChange(db, mia, { op: 'remove', batchId: b.id, amount: '2', expected: b.quantity }, 'en'),
      '📤 Removed **2 SCU** · **Test Metal** Q820\nBatch: 10.5 SCU · Test Station · personal');
    assert.equal(await bookChange(db, mia, { op: 'remove', batchId: b.id, amount: '10.5', expected: '10.5' }, 'de'),
      '📤 Entnommen **10.5 SCU** · **Testmetall** Q820\nBatch: leer · Test Station');
  });

  it('refuses a booking against a batch that changed since the modal showed it', async () => {
    const b = (await add(db, mia, { ...metal, quality: 700, amount: '3' })).batch!;
    await add(db, mia, { ...metal, quality: 700, amount: '1' });
    await assert.rejects(bookChange(db, mia, { op: 'adjust', batchId: b.id, amount: '1', expected: '3' }, 'en'),
      (err: unknown) => err instanceof UserError && err.key === 'stock.err.batchChanged');
  });

  it('describes corrections by their result', async () => {
    const b = (await add(db, mia, { ...metal, quality: 600, amount: '5' })).batch!;
    assert.equal(await bookChange(db, mia, { op: 'adjust', batchId: b.id, amount: '6', expected: '5' }, 'en'),
      '✏️ Corrected by **+1 SCU** · **Test Metal** Q600\nBatch: 6 SCU · Test Station · personal\n-# Test Metal in your stock: 10 SCU');
  });

  it('shares what it books in the ticked orgs, on top of the shares the batch already has', async () => {
    const text = await bookAdd(db, mia, { ...metal, quality: 900, amount: '2', shareIn: [G] }, 'en');
    assert.equal(text, '📥 Booked **2 SCU** · **Test Metal** Q900\nTest Station · shared in Stock Cmd Org\n-# Test Metal in your stock: 12 SCU');
    // Into an existing batch: its amount differs from the booked one and is shown
    assert.match(await bookAdd(db, mia, { ...metal, quality: 900, amount: '1', shareIn: [G2] }, 'en'), /\nBatch: 3 SCU · Test Station · shared in /);
    const [batch] = (await stockList(db, { scope: { personalOf: MIA } }, 'en')).filter((p) => p.batch.quality === 900);
    assert.deepEqual(batch!.sharedIn, [G, G2].sort());
    assert.equal(batch!.batch.quantity, '3.000000');
    // Nothing ticked: an existing batch keeps its shares
    await bookAdd(db, mia, { ...metal, quality: 900, amount: '1', shareIn: [] }, 'en');
    assert.equal((await stockList(db, { scope: { guildId: G2 } }, 'en')).find((p) => p.batch.id === batch!.batch.id)?.batch.quantity, '4.000000');
  });

  it('sets and takes back shares', async () => {
    const b = (await add(db, mia, { ...metal, quality: 500, amount: '1' })).batch!;
    assert.equal(await bookShare(db, mia, b.id, [G, G2], 'en'), '📢 Shared in Second Org, Stock Cmd Org\n**Test Metal** Q500 · 1 SCU · Test Station');
    assert.equal(await bookShare(db, mia, b.id, [], 'de'), '↩️ Nicht mehr geteilt\n**Testmetall** Q500 · 1 SCU · Test Station');
    await assert.rejects(bookShare(db, mia, b.id, [], 'en'), (err: unknown) => err instanceof UserError && err.key === 'stock.err.shareNoChange');
  });

  it('gives to a member: the batch becomes theirs, unshared', async () => {
    const b = (await add(db, mia, { ...metal, quality: 550, amount: '4' })).batch!;
    assert.equal(await bookChange(db, mia, { op: 'give', batchId: b.id, amount: '1', expected: '4', toOwnerUserId: OLGA, toOwnerName: 'Olga' }, 'en'),
      '📦 Gave **1 SCU** · **Test Metal** Q550\nTo **Olga** · Test Station');
    const olgas = await stockList(db, { scope: { personalOf: OLGA } }, 'en');
    assert.ok(olgas.some((p) => p.batch.quality === 550 && p.batch.quantity === '1.000000' && !p.sharedIn.length));
  });

  it('books components by their label with their stats, and changes the stats through a correction', async () => {
    const cooler = { kind: 'item' as const, uuid: U.output, locationUuid: U.station, quality: COMPONENT_QUALITY };
    assert.equal(await bookAdd(db, mia, { ...cooler, amount: '2', shareIn: [], stats: { [U.property]: '5' } }, 'en'),
      '📥 Booked **2 pcs** · **Test Cooler · Cooler · S2 · B Military** · GPP\\_Test +5.0 %\nTest Station · personal');
    const b = (await stockList(db, { scope: { personalOf: MIA } }, 'en')).find((p) => p.component)!;
    assert.equal(await bookChange(db, mia, { op: 'adjust', batchId: b.batch.id, amount: '2', expected: b.batch.quantity, stats: { [U.property]: '7.5' } }, 'en'),
      '✏️ Stats changed · **Test Cooler · Cooler · S2 · B Military** · GPP\\_Test +7.5 %\nBatch: 2 pcs · Test Station · personal');
    // Only the amount: the stats stay
    const now = (await stockList(db, { scope: { personalOf: MIA } }, 'en')).find((p) => p.component)!;
    assert.equal(await bookChange(db, mia, { op: 'adjust', batchId: now.batch.id, amount: '3', expected: now.batch.quantity }, 'en'),
      '✏️ Corrected by **+1 pcs** · **Test Cooler · Cooler · S2 · B Military** · GPP\\_Test +7.5 %\nBatch: 3 pcs · Test Station · personal');
  });

  it('lists shared stock with owners, all stock with your own marked, your own with what you share marked', async () => {
    await add(db, olga, { kind: 'item', uuid: U.gem, locationUuid: U.station, quality: 300, amount: '7', org: true });
    const org = listLines(await stockList(db, { scope: { guildId: G } }, 'en'), 'o', MIA, 0, 'en').lines;
    assert.ok(org.includes('- Q300 · 7 pcs · Test Station · Olga'));
    assert.ok(org.includes('- Q900 · 4 SCU · Test Station · Mia'));
    const all = listLines(await stockList(db, { scope: { allOf: MIA } }, 'en'), 'a', MIA, 0, 'en').lines;
    assert.ok(all.includes('- Q300 · 7 pcs · Test Station · Olga'));
    assert.ok(all.includes('- Q900 · 4 SCU · Test Station · Pers.'));
    const own = listLines(await stockList(db, { scope: { personalOf: MIA } }, 'de'), 'p', MIA, 0, 'de').lines;
    assert.ok(own.includes('- Q900 · 4 SCU · Test Station · geteilt'));
    assert.ok(own.includes('- Q700 · 4 SCU · Test Station'));
  });
});
