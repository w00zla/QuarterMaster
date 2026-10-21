// UEX trading prices: matching to catalog materials and the price aggregation (pure).
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildTrade, nameKey } from '../src/ext/trade.ts';
import { valueMicros, wholeOfMicros } from '../src/stock/amount.ts';
import { stockValue } from '../src/webapp/trade.ts';

const METAL = '10000000-0000-0000-0000-0000000000a1';
const ORE = '10000000-0000-0000-0000-0000000000a2';
const GEM = '10000000-0000-0000-0000-0000000000a3';
const T1 = 1_760_000_000;
const T2 = 1_761_000_000;

const terminals = [
  { id: 1, name: 'Admin - Alpha', star_system_name: 'Stanton' },
  { id: 2, name: 'Admin - Beta', star_system_name: 'Pyro' },
];
const commodities = [
  { id: 10, name: 'Test-Metal', price_sell: 90, price_buy: 0 },
  { id: 11, name: 'Test Metal (Ore)', price_sell: 5, price_buy: 0 },
  { id: 12, name: 'Nothing in the catalog', price_sell: 1, price_buy: 1 },
];
const price = (commodity: number, terminal: number, sell: number, buy: number, date: number, extra: Record<string, unknown> = {}) =>
  ({ id_commodity: commodity, id_terminal: terminal, price_sell: sell, price_buy: buy, date_modified: date, ...extra });

describe('UEX trade prices', () => {
  it('normalizes names: case, spaces and punctuation dropped', () => {
    assert.equal(nameKey('Test-Metal'), nameKey('test metal'));
    assert.notEqual(nameKey('Test Metal (Ore)'), nameKey('Test Metal'));
  });

  it('matches commodities by name and items by UUID, ignores 0 prices, best price first', () => {
    const trade = buildTrade({
      terminals, commodities,
      commodities_prices_all: [
        price(10, 2, 80, 0, T2, { scu_sell: 50, scu_sell_avg: 40 }),
        price(10, 1, 100, 0, T1, { scu_sell: 500, scu_sell_avg: 400, scu_buy: 0 }),
        price(10, 3, 0, 0, T2),
        price(11, 1, 0, 7, T1, { scu_buy: 30, scu_buy_avg: 20 }),
        price(12, 1, 1, 1, T1),
      ],
      items_prices_all: [
        { item_uuid: GEM.toUpperCase(), id_terminal: 2, price_sell: 0, price_buy: 15, date_modified: T1 },
        { item_uuid: GEM, id_terminal: 1, price_sell: 0, price_buy: 12, date_modified: T2, terminal_name: 'ignored' },
        { item_uuid: '10000000-0000-0000-0000-0000000000ff', id_terminal: 9, price_sell: 0, price_buy: 0, date_modified: T1 },
      ],
    }, [{ uuid: METAL, nameEn: 'Test Metal' }, { uuid: ORE, nameEn: 'Test Metal (Ore)' }]);

    const metal = trade.get(METAL)!;
    assert.deepEqual(metal.summary, { date: new Date(T2 * 1000).toISOString(), sell: { min: 80, max: 100, avg: 90, terminals: 2 }, buy: null });
    assert.deepEqual(metal.sell.map((o) => [o.terminal, o.system, o.price, o.scu, o.scuAvg]), [
      ['Admin - Alpha', 'Stanton', 100, 500, 400], ['Admin - Beta', 'Pyro', 80, 50, 40],
    ]);
    // UEX's average 0 = none
    const ore = trade.get(ORE)!;
    assert.deepEqual([ore.summary.sell, ore.summary.buy], [null, { min: 7, max: 7, avg: null, terminals: 1 }]);
    assert.deepEqual(ore.buy.map((o) => [o.price, o.scu, o.scuAvg]), [[7, 30, 20]]);
    // Items: no average, no stock; the catalog's UUIDs are lower case
    const gem = trade.get(GEM)!;
    assert.deepEqual(gem.summary.buy, { min: 12, max: 15, avg: null, terminals: 2 });
    assert.deepEqual(gem.buy.map((o) => [o.terminal, o.price, o.scu]), [['Admin - Alpha', 12, null], ['Admin - Beta', 15, null]]);
    // Not traded at all: nothing
    assert.equal(trade.has('10000000-0000-0000-0000-0000000000ff'), false);
    assert.equal(trade.size, 3);
  });

  it('without terminals: the name of the price row', () => {
    const trade = buildTrade({ commodities, commodities_prices_all: [price(10, 7, 3, 0, T1, { terminal_name: 'Somewhere' })] }, [{ uuid: METAL, nameEn: 'Test Metal' }]);
    assert.deepEqual(trade.get(METAL)!.sell.map((o) => [o.terminal, o.system]), [['Somewhere', null]]);
  });

  it('values amounts exactly at a price, components apart, unpriced left out', () => {
    assert.equal(valueMicros('0.000001', 1), 1n);
    assert.equal(valueMicros('12.5', 100.25), 1_253_125_000n);
    assert.equal(wholeOfMicros(valueMicros('0.1', 5)), 1n);
    assert.equal(wholeOfMicros(valueMicros('0.1', 4)), 0n);
    const prices = new Map([['a', 100.25], ['c', 1000]]);
    assert.deepEqual(stockValue([
      { uuid: 'a', component: false, total: '12.500000' }, { uuid: 'b', component: false, total: '99' }, { uuid: 'c', component: true, total: '2' },
    ], (u) => prices.get(u)), { total: '3253', resources: '1253', components: '2000' });
  });
});
