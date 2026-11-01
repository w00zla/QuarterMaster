// The item finder's pure parts: best prices and the items.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildTrade } from '../src/ext/trade.ts';
import { bestPrices, tradeItems } from '../src/webapp/trade.ts';

const METAL = '10000000-0000-0000-0000-0000000000a1';
const GEM = '10000000-0000-0000-0000-0000000000a3';
const T1 = 1_760_000_000;
const T2 = 1_761_000_000;

const terminals = [
  { id: 1, name: 'Admin - Alpha', star_system_name: 'Stanton' },
  { id: 2, name: 'Admin - Beta', star_system_name: 'Pyro' },
  { id: 3, name: 'Shop - Alpha', star_system_name: 'Stanton' },
  { id: 4, name: 'Admin - Nowhere' },
];
const data = buildTrade({
  terminals,
  commodities: [{ id: 10, name: 'Test Metal', price_sell: 0, price_buy: 0 }],
  commodities_prices_all: [
    { id_commodity: 10, id_terminal: 1, price_sell: 100, price_buy: 0, date_modified: T1 },
    { id_commodity: 10, id_terminal: 2, price_sell: 80, price_buy: 125, date_modified: T2 },
    { id_commodity: 10, id_terminal: 3, price_sell: 0, price_buy: 130, date_modified: T1 },
  ],
  items_prices_all: [
    { item_uuid: GEM, id_terminal: 1, price_buy: 15, price_sell: 0, date_modified: T1 },
    { item_uuid: GEM, id_terminal: 4, price_buy: 0, price_sell: 5, date_modified: T2 },
  ],
}, [{ uuid: METAL, nameEn: 'Test Metal' }]);

describe('trade item finder', () => {
  it('best prices: lowest buy, highest sell', () => {
    assert.deepEqual(bestPrices(data.get(METAL)!), { buy: 125, sell: 100 });
    assert.deepEqual(bestPrices(data.get(GEM)!), { buy: 15, sell: 5 });
    assert.deepEqual(bestPrices({ sell: [], buy: [] }), { buy: null, sell: null });
  });

  it('items: only known materials with an offer, by name', () => {
    const meta = new Map([
      [METAL, { kind: 'resource' as const, name: 'Zeta Metal', type: null, typeLabel: null, size: null, gradeLetter: null, bookable: true }],
      [GEM, { kind: 'item' as const, name: 'Alpha Gem', type: 'Misc', typeLabel: 'Misc', size: 2, gradeLetter: 'A', bookable: false }],
    ]);
    assert.deepEqual(tradeItems(data, meta).map((i) => [i.uuid, i.name, i.buy, i.sell, i.bookable]), [[GEM, 'Alpha Gem', 15, 5, false], [METAL, 'Zeta Metal', 125, 100, true]]);
    // Unknown (retired) materials are left out
    assert.deepEqual(tradeItems(data, new Map([[GEM, meta.get(GEM)!]])).map((i) => i.uuid), [GEM]);
  });
});
