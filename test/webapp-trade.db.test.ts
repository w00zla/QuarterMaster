// Runs against TEST_DATABASE_URL only; the ext, web, bot, app and catalog schemas there are dropped and recreated.
// The web app's trading data from fake UEX snapshots: price summary, trading dialog, info card, the
// overview's total value (personal and org, the same batches as the other figures).
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type { Db } from '../src/db/client.ts';
import { connectAs, prepareDb } from './roles.ts';
import { runImport } from '../src/catalog/import/apply.ts';
import { sha256, stableStringify } from '../src/catalog/import/plan.ts';
import { syncMember } from '../src/bot/roster.ts';
import { ensureGuild, updateGuildSettings } from '../src/bot/settings.ts';
import { storeSnapshot } from '../src/ext/store.ts';
import type { MaterialInfo, SummaryResponse, TradeItemsResponse, TradePricesResponse, TradeResponse } from '../src/webapp/api-types.ts';
import { createApp } from '../src/webapp/app.ts';
import type { DiscordLogin } from '../src/webapp/discord.ts';
import { createSession } from '../src/webapp/session.ts';
import { U, fixtureSnapshot } from './fixtures.ts';

const url = process.env.TEST_DATABASE_URL;
const ORIGIN = 'https://qm.test';
const G = '700000000000000061';
const MEMBER_ROLE = '710000000000000061';
const [OLGA, MIA, SOLO] = ['740000000000000061', '740000000000000062', '740000000000000063'];
const noLogin: DiscordLogin = { start: () => Promise.reject(new Error('unused')), finish: () => Promise.reject(new Error('unused')) };
const T1 = 1_760_000_000;
const T2 = 1_761_000_000;

const terminals = [
  { id: 1, name: 'Admin - Alpha', star_system_name: 'Stanton' },
  { id: 2, name: 'Admin - Beta', star_system_name: 'Pyro' },
];
const commodities = [{ id: 10, name: 'Test Metal', price_sell: 90, price_buy: 120 }];
const commodityPrices = [
  { id_commodity: 10, id_terminal: 1, price_sell: 100, price_buy: 0, scu_sell: 500, scu_sell_avg: 400, scu_buy: 0, scu_buy_avg: 0, date_modified: T1 },
  { id_commodity: 10, id_terminal: 2, price_sell: 80, price_buy: 125, scu_sell: 50, scu_sell_avg: 40, scu_buy: 30, scu_buy_avg: 20, date_modified: T2 },
];
const itemPrices = [
  { item_uuid: U.gem, id_terminal: 1, price_sell: 0, price_buy: 15, date_modified: T1 },
  { item_uuid: U.output, id_terminal: 2, price_sell: 1000, price_buy: 2000, date_modified: T1 },
];

describe('web app trading (database)', { skip: url ? false : 'TEST_DATABASE_URL not set' }, () => {
  let db: Db;
  let webDb: Db;
  let closeDb: () => Promise<void>;
  let closeWeb: () => Promise<void>;
  let app: ReturnType<typeof createApp>;
  const tokens = new Map<string, string>();

  const headers = (user: string) => ({ cookie: `__Host-qm_session=${tokens.get(user)}`, origin: ORIGIN, 'sec-fetch-site': 'same-origin' });
  const get = async <T>(user: string, path: string) => {
    const res = await app.request(`/api${path}`, { headers: headers(user) });
    return { status: res.status, body: (await res.json()) as T };
  };
  const post = async (user: string, path: string, body: unknown) => {
    const res = await app.request(`/api${path}`, {
      method: 'POST', body: JSON.stringify(body), headers: { ...headers(user), 'content-type': 'application/json' },
    });
    return res.status;
  };
  const summary = async (user: string) => (await get<SummaryResponse>(user, '/summary')).body;

  before(async () => {
    await prepareDb(url);
    ({ db, close: closeDb } = connectAs(url, 'qm_app'));
    ({ db: webDb, close: closeWeb } = connectAs(url, 'qm_web'));
    const snap = fixtureSnapshot();
    await runImport(db, snap, sha256(stableStringify(snap)), { dryRun: false, force: false, allowDowngrade: false, maxRetireRatio: 0.1, maxChangeRatio: 0.5 });
    await ensureGuild(db, G, 'Trade Org');
    const settings = await updateGuildSettings(db, G, { memberRoleIds: [MEMBER_ROLE] });
    for (const id of [OLGA, MIA]) {
      await syncMember(db, G, settings, id, { userId: id, displayName: `n${id.slice(-2)}`, roleIds: [MEMBER_ROLE], bot: false });
    }
    for (const id of [OLGA, MIA, SOLO]) {
      tokens.set(id, await createSession(webDb, { id, username: `u${id.slice(-2)}`, globalName: null, avatar: null }));
    }
    app = createApp(webDb, noLogin, { origin: ORIGIN, trustProxy: false, distDir: null });
  });
  after(async () => { await closeDb?.(); await closeWeb?.(); });

  it('without UEX data: no prices, no value', async () => {
    assert.deepEqual((await get<TradePricesResponse>(SOLO, '/trade/prices')).body, { prices: {} });
    assert.equal((await get(SOLO, `/trade/${U.metal}`)).status, 404);
    assert.equal((await get<MaterialInfo>(SOLO, `/info/material/${U.metal}`)).body.prices, null);
    assert.equal((await summary(SOLO)).personal.value, null);
  });

  it('prices per material: summary, every terminal best first, the info card', async () => {
    await storeSnapshot(db, 'uex', 'terminals', terminals);
    await storeSnapshot(db, 'uex', 'commodities', commodities, true);
    await storeSnapshot(db, 'uex', 'commodities_prices_all', commodityPrices, true);
    await storeSnapshot(db, 'uex', 'items_prices_all', itemPrices, true);

    const { prices } = (await get<TradePricesResponse>(SOLO, '/trade/prices')).body;
    assert.deepEqual(Object.keys(prices).sort(), [U.metal, U.gem, U.output].sort());
    const metal = { date: new Date(T2 * 1000).toISOString(), sell: { min: 80, max: 100, avg: 90, terminals: 2 }, buy: { min: 125, max: 125, avg: 120, terminals: 1 } };
    assert.deepEqual(prices[U.metal], metal);
    assert.deepEqual(prices[U.gem], { date: new Date(T1 * 1000).toISOString(), sell: null, buy: { min: 15, max: 15, avg: null, terminals: 1 } });

    const trade = (await get<TradeResponse>(SOLO, `/trade/${U.metal}`)).body;
    assert.deepEqual(trade.prices, metal);
    assert.deepEqual(trade.sell.map((o) => [o.location, o.terminal, o.system, o.price, o.scu, o.scuAvg, o.date]), [
      ['Alpha', 'Admin', 'Stanton', 100, 500, 400, new Date(T1 * 1000).toISOString()],
      ['Beta', 'Admin', 'Pyro', 80, 50, 40, new Date(T2 * 1000).toISOString()],
    ]);
    assert.deepEqual(trade.buy.map((o) => [o.location, o.terminal, o.price, o.scu, o.scuAvg]), [['Beta', 'Admin', 125, 30, 20]]);
    const gem = (await get<TradeResponse>(SOLO, `/trade/${U.gem}`)).body;
    assert.deepEqual([gem.sell, gem.buy.map((o) => [o.price, o.scu])], [[], [[15, null]]]);
    assert.equal((await get(SOLO, `/trade/${U.ore}`)).status, 404);
    assert.equal((await get(SOLO, '/trade/nope')).status, 400);

    assert.deepEqual((await get<MaterialInfo>(SOLO, `/info/material/${U.metal}`)).body.prices, metal);
    assert.deepEqual((await get<MaterialInfo>(SOLO, `/info/material/${U.gem}`)).body.prices?.buy, { min: 15, max: 15, avg: null, terminals: 1 });

    // A new price snapshot replaces the old one in the cache
    await storeSnapshot(db, 'uex', 'commodities_prices_all', [{ ...commodityPrices[0]!, price_sell: 110 }], true);
    assert.deepEqual((await get<TradePricesResponse>(SOLO, '/trade/prices')).body.prices[U.metal]?.sell, { min: 110, max: 110, avg: 90, terminals: 1 });
    await storeSnapshot(db, 'uex', 'commodities_prices_all', commodityPrices, true);
  });

  it('item finder: items with best prices', async () => {
    const items = (await get<TradeItemsResponse>(SOLO, '/trade/items?lang=en')).body.items;
    assert.deepEqual(items.map((i) => i.uuid).sort(), [U.metal, U.gem, U.output].sort());
    const metal = items.find((i) => i.uuid === U.metal)!;
    assert.deepEqual([metal.kind, metal.type, metal.buy, metal.sell, metal.bookable], ['resource', null, 125, 100, true]);
    const output = items.find((i) => i.uuid === U.output)!;
    assert.deepEqual([output.kind, output.buy, output.sell, output.bookable], ['item', 2000, 1000, true]);
    assert.deepEqual(items.map((i) => i.name), [...items.map((i) => i.name)].sort((a, b) => a.localeCompare(b)));
    assert.equal((await get<TradeItemsResponse>(SOLO, '/trade/items?lang=de')).body.items.length, items.length);
  });

  it('total value at the best sell price: personal and per org, unpriced batches left out', async () => {
    const add = (user: string, subjectUuid: string, quality: number, amount: string, guildIds?: string[]) =>
      post(user, '/stock/add', { subjectUuid, locationUuid: U.station, quality, amount, guildIds });
    assert.equal(await add(SOLO, U.metal, 700, '12.5'), 200);
    // No sell price for the gem: it does not count
    assert.equal(await add(SOLO, U.gem, 500, '3'), 200);
    assert.deepEqual((await summary(SOLO)).personal.value, { total: '1250', resources: '1250', components: '0' });

    assert.equal(await add(MIA, U.metal, 800, '2.255', [G]), 200);
    assert.equal(await add(MIA, U.output, 0, '2', [G]), 200);
    // Not shared: personal only
    assert.equal(await add(MIA, U.metal, 900, '1'), 200);
    const mia = await summary(MIA);
    assert.deepEqual(mia.personal.value, { total: '2326', resources: '326', components: '2000' });
    assert.deepEqual(mia.orgs.map((o) => [o.guildId, o.value]), [[G, { total: '2226', resources: '226', components: '2000' }]]);
    // Another member sees the org's value; their own stock is empty
    const olga = await summary(OLGA);
    assert.deepEqual([olga.personal.value, olga.orgs[0]!.value], [{ total: '0', resources: '0', components: '0' }, mia.orgs[0]!.value]);
  });
});
