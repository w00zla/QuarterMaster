// Runs against TEST_DATABASE_URL only; the ext, web, bot, app and catalog schemas there are dropped and recreated.
// The admin's UEX trade coverage: commodities matched to catalog resources by English name, items by UUID.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { type Db } from '../src/db/client.ts';
import { connectAs, prepareDb } from './roles.ts';
import { runImport } from '../src/catalog/import/apply.ts';
import { sha256, stableStringify } from '../src/catalog/import/plan.ts';
import { storeSnapshot } from '../src/ext/store.ts';
import { getUexTrade } from '../src/adminapp/queries.ts';
import { FPS, FPS_RECORDS, RECORDS, U, fixtureSnapshot } from './fixtures.ts';

const url = process.env.TEST_DATABASE_URL;

describe('admin: UEX trade coverage (database)', { skip: url ? false : 'TEST_DATABASE_URL not set' }, () => {
  let db: Db;
  let close: () => Promise<void>;

  before(async () => {
    await prepareDb(url);
    ({ db, close } = connectAs(url, 'qm_app'));
    const snap = fixtureSnapshot({ ...RECORDS, ...FPS_RECORDS });
    await runImport(db, snap, sha256(stableStringify(snap)), { dryRun: false, force: false, allowDowngrade: false, maxRetireRatio: 0.1, maxChangeRatio: 0.5 });
  });
  after(async () => close?.());

  it('is empty without UEX data', async () => {
    const trade = await getUexTrade(db, 'en');
    assert.deepEqual([trade.terminals, trade.commodityPrices, trade.itemPrices], [0, 0, 0]);
    assert.deepEqual(trade.commodities, { total: 0, matched: 0, unmatched: [] });
    assert.deepEqual([trade.resources.total, trade.resources.matched, trade.resources.priced, trade.resources.unmatched.length], [2, 0, 0, 2]);
    // Gear: the cooler, the rifle, the helmet and the optic (not the gem)
    assert.deepEqual(trade.items, { priced: 0, gear: 4, gearPriced: 0 });
  });

  it('matches commodities by English name and items by UUID', async () => {
    await storeSnapshot(db, 'uex', 'terminals', [{ id: 1, name: 'Admin - Alpha', star_system_name: 'Stanton' }]);
    await storeSnapshot(db, 'uex', 'commodities', [
      { id: 10, name: 'Test Metal', price_sell: 90, price_buy: 120 }, { id: 11, name: 'Laranite' }, { id: 12, name: 'Agricium' },
    ]);
    await storeSnapshot(db, 'uex', 'commodities_prices_all', [
      { id_commodity: 10, id_terminal: 1, price_sell: 100, price_buy: 0, date_modified: 1_760_000_000 },
    ]);
    await storeSnapshot(db, 'uex', 'items_prices_all', [
      { item_uuid: U.gem, id_terminal: 1, price_sell: 15, price_buy: 0, date_modified: 1_760_000_000 },
      { item_uuid: FPS.rifle.toUpperCase(), id_terminal: 1, price_sell: 0, price_buy: 2000, date_modified: 1_760_000_000 },
      // Not traded on either side: no price
      { item_uuid: U.output, id_terminal: 1, price_sell: 0, price_buy: 0, date_modified: 1_760_000_000 },
      { item_uuid: '99999999-0000-0000-0000-000000000001', id_terminal: 1, price_sell: 5, price_buy: 0, date_modified: 1_760_000_000 },
    ]);

    // German names shown, English names matched
    const trade = await getUexTrade(db, 'de');
    assert.deepEqual([trade.terminals, trade.commodityPrices, trade.itemPrices], [1, 1, 4]);
    assert.deepEqual(trade.commodities, { total: 3, matched: 1, unmatched: ['Agricium', 'Laranite'] });
    assert.deepEqual(trade.resources, {
      total: 2, matched: 1, priced: 1, unmatched: [{ uuid: U.ore, name: 'Test Metal (Ore)', isOre: true }],
    });
    assert.deepEqual(trade.items, { priced: 2, gear: 4, gearPriced: 1 });
  });
});
