// Trading prices from the latest UEX snapshots (community reports, aUEC): per catalog material the
// terminals that buy or sell it. Commodities have no UUIDs: they are matched to catalog resources by
// their English name (`nameKey`); items carry the game's UUID (`item_uuid`). A price of 0 = not traded on
// that side. UEX fields (commodities_prices_all): price_sell / scu_sell (+ _avg) = what the terminal
// pays and takes when the player sells, price_buy / scu_buy = what it asks and has in stock when the
// player buys; items_prices_all has no stock. `commodities` holds UEX's average prices (items have none).
import { sql } from 'drizzle-orm';
import type { Db } from '../db/client.ts';
import { importCache } from '../db/import-cache.ts';
import { locText, one, rows } from '../db/query.ts';
import type { PriceRange, PriceSummary } from '../webapp/api-types.ts';

export const TRADE_ENDPOINTS = ['terminals', 'commodities', 'commodities_prices_all', 'items_prices_all'] as const;
type Endpoint = (typeof TRADE_ENDPOINTS)[number];
type Row = Record<string, unknown>;

/** One terminal's price on one side. */
export interface Offer {
  // Where (station, city or outpost) and which shop/terminal there ("ARC-L1 Wide Forest Station", "Admin")
  location: string;
  terminal: string;
  system: string | null;
  price: number;
  // Sell side: what the terminal takes (demand), buy side: its stock; items: null
  scu: number | null;
  scuAvg: number | null;
  // Unix seconds of the report
  date: number;
}

export interface MaterialTrade {
  summary: PriceSummary;
  // Best price first: sell highest, buy lowest
  sell: Offer[];
  buy: Offer[];
}

/** A catalog resource: its English name. */
export interface ResourceName {
  uuid: string;
  nameEn: string;
}

/** "Quantainium", "Agricium (Ore)" -> "quantainium", "agriciumore" (exact names, case and punctuation dropped). */
export const nameKey = (name: string) => name.toLowerCase().replace(/[^a-z0-9]/g, '');

const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const positive = (v: unknown) => { const n = num(v); return n !== null && n > 0 ? n : null; };

function range(offers: Offer[], avg: number | null): PriceRange | null {
  if (!offers.length) return null;
  const prices = offers.map((o) => o.price);
  return { min: Math.min(...prices), max: Math.max(...prices), avg, terminals: new Set(offers.map((o) => `${o.location}|${o.terminal}`)).size };
}

/**
 * A UEX terminal split into its place and its shop. UEX names them "<shop> - <place>" ("Admin - ARC-L1",
 * "TDD - Trade and Development Division - Area 18"); the place comes from the station, city or outpost
 * field, else the name's last part. A name that is only the place ("ArcCorp Mining Area 056") gives its
 * company as the shop.
 */
export function terminalPlace(t: Row): { location: string; shop: string } {
  const name = str(t.name) ?? str(t.displayname) ?? '?';
  const parts = name.split(' - ').map((p) => p.trim()).filter(Boolean);
  const location = str(t.space_station_name) ?? str(t.city_name) ?? str(t.outpost_name) ?? (parts.length > 1 ? parts.at(-1)! : str(t.displayname) ?? name);
  const shop = parts.length > 1 ? parts.slice(0, -1).join(' - ') : name;
  return { location, shop: shop === location ? str(t.company_name) ?? shop : shop };
}

/** Pure: the trade data per catalog material UUID from the UEX `data` arrays. */
export function buildTrade(
  data: Partial<Record<Endpoint, Row[]>>, resources: Iterable<ResourceName>,
): Map<string, MaterialTrade> {
  const terminals = new Map<number, { location: string; shop: string; system: string | null }>();
  for (const t of data.terminals ?? []) {
    if (typeof t.id === 'number') terminals.set(t.id, { ...terminalPlace(t), system: str(t.star_system_name) });
  }
  const byName = new Map<string, string[]>();
  for (const r of resources) byName.set(nameKey(r.nameEn), [...(byName.get(nameKey(r.nameEn)) ?? []), r.uuid]);
  // UEX commodity ID -> catalog resource UUIDs and its average prices
  const commodities = new Map<number, { uuids: string[]; sell: number | null; buy: number | null }>();
  for (const c of data.commodities ?? []) {
    const uuids = typeof c.name === 'string' ? byName.get(nameKey(c.name)) : undefined;
    if (typeof c.id === 'number' && uuids) commodities.set(c.id, { uuids, sell: positive(c.price_sell), buy: positive(c.price_buy) });
  }

  const collected = new Map<string, { sell: Offer[]; buy: Offer[]; avgSell: number | null; avgBuy: number | null }>();
  const entry = (uuid: string, avgSell: number | null, avgBuy: number | null) => {
    let e = collected.get(uuid);
    if (!e) collected.set(uuid, (e = { sell: [], buy: [], avgSell, avgBuy }));
    return e;
  };
  const offer = (r: Row, price: number, scu: unknown, scuAvg: unknown): Offer => {
    const t = typeof r.id_terminal === 'number' ? terminals.get(r.id_terminal) : undefined;
    // Without the terminals snapshot: the price row's terminal name for both
    const fallback = str(r.terminal_name) ?? `#${String(r.id_terminal)}`;
    return {
      location: t?.location ?? fallback, terminal: t?.shop ?? fallback, system: t?.system ?? null,
      price, scu: num(scu), scuAvg: num(scuAvg), date: num(r.date_modified) ?? 0,
    };
  };

  for (const r of data.commodities_prices_all ?? []) {
    const c = typeof r.id_commodity === 'number' ? commodities.get(r.id_commodity) : undefined;
    if (!c) continue;
    const sell = positive(r.price_sell);
    const buy = positive(r.price_buy);
    for (const uuid of c.uuids) {
      const e = entry(uuid, c.sell, c.buy);
      if (sell !== null) e.sell.push(offer(r, sell, r.scu_sell, r.scu_sell_avg));
      if (buy !== null) e.buy.push(offer(r, buy, r.scu_buy, r.scu_buy_avg));
    }
  }
  for (const r of data.items_prices_all ?? []) {
    const uuid = str(r.item_uuid)?.toLowerCase();
    if (!uuid) continue;
    const sell = positive(r.price_sell);
    const buy = positive(r.price_buy);
    const e = entry(uuid, null, null);
    if (sell !== null) e.sell.push(offer(r, sell, null, null));
    if (buy !== null) e.buy.push(offer(r, buy, null, null));
  }

  const result = new Map<string, MaterialTrade>();
  for (const [uuid, e] of collected) {
    if (!e.sell.length && !e.buy.length) continue;
    const byPlace = (a: Offer, b: Offer) => a.location.localeCompare(b.location) || a.terminal.localeCompare(b.terminal);
    e.sell.sort((a, b) => b.price - a.price || byPlace(a, b));
    e.buy.sort((a, b) => a.price - b.price || byPlace(a, b));
    const date = Math.max(...[...e.sell, ...e.buy].map((o) => o.date));
    result.set(uuid, {
      summary: { date: new Date(date * 1000).toISOString(), sell: range(e.sell, e.avgSell), buy: range(e.buy, e.avgBuy) },
      sell: e.sell, buy: e.buy,
    });
  }
  return result;
}

/** Every resource not retired, by English name (ores too), reloaded with the catalog. */
const resourceNames = importCache(async (db): Promise<ResourceName[]> => rows<ResourceName>(db, sql`
  SELECT r.uuid, coalesce(${locText('en', sql`r.name_key`)}, r.key) AS "nameEn" FROM catalog.resource r WHERE r.retired_at IS NULL`));

let cached: { key: string; resources: ResourceName[]; value: Promise<Map<string, MaterialTrade>> } | null = null;

/** The trade data of the latest snapshots; empty while there are none. Rebuilt when a snapshot or the catalog changes. */
export async function tradeData(db: Db): Promise<Map<string, MaterialTrade>> {
  const latest = await rows<{ endpoint: Endpoint; id: number }>(db, sql`
    SELECT endpoint, max(id)::int AS id FROM ext.snapshot
    WHERE source = 'uex' AND endpoint IN (${sql.join(TRADE_ENDPOINTS.map((e) => sql`${e}`), sql`, `)}) GROUP BY endpoint ORDER BY endpoint`);
  const resources = await resourceNames(db, 'en');
  const key = latest.map((l) => `${l.endpoint}:${l.id}`).join(',');
  if (cached?.key === key && cached.resources === resources) return cached.value;
  const value = (async () => {
    const data: Partial<Record<Endpoint, Row[]>> = {};
    for (const l of latest) data[l.endpoint] = (await one<{ data: Row[] }>(db, sql`SELECT data FROM ext.snapshot WHERE id = ${l.id}`))?.data ?? [];
    return buildTrade(data, resources);
  })();
  cached = { key, resources, value };
  value.catch(() => { if (cached?.value === value) cached = null; });
  return value;
}

/** A material's trade data; null without any price. */
export async function materialTrade(db: Db, uuid: string): Promise<MaterialTrade | null> {
  return (await tradeData(db)).get(uuid) ?? null;
}
