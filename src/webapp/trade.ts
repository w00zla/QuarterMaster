// The web app's trading data (UEX prices from ext.snapshot): the info card's summary, the stock lists'
// UEC columns, the overview's total value and the trading dialog. Registered by registerRoutes.
import { sql } from 'drizzle-orm';
import type { Hono } from 'hono';
import type { Db } from '../db/client.ts';
import { rows } from '../db/query.ts';
import { isFpsType } from '../catalog/components.ts';
import { importCache } from '../db/import-cache.ts';
import { getItems, getResources } from '../adminapp/queries.ts';
import { tradeData, type MaterialTrade, type Offer } from '../ext/trade.ts';
import { valueMicros, wholeOfMicros, formatAmount } from '../stock/amount.ts';
import { materialCatalog } from '../stock/lookup.ts';
import { componentItemSql } from '../stock/service.ts';
import type {
  PriceSummary, StockValue, TradeItem, TradeItemsResponse, TradeOffer, TradePricesResponse, TradeResponse,
} from './api-types.ts';
import { HttpError, type Env } from './routes.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const toOffer = (o: Offer): TradeOffer => ({ ...o, date: new Date(o.date * 1000).toISOString() });

/** Pure: the lowest buy and the highest sell price of a material (null = none on that side). */
export function bestPrices(m: Pick<MaterialTrade, 'sell' | 'buy'>): { buy: number | null; sell: number | null } {
  return {
    buy: m.buy.length ? Math.min(...m.buy.map((o) => o.price)) : null,
    sell: m.sell.length ? Math.max(...m.sell.map((o) => o.price)) : null,
  };
}

/** The catalog side of the item finder (not retired materials, per language), reloaded with the catalog. */
interface FinderMeta {
  kind: 'resource' | 'item';
  name: string;
  type: string | null;
  typeLabel: string | null;
  size: number | null;
  gradeLetter: string | null;
  bookable: boolean;
}
const finderMeta = importCache(async (db: Db, lang: string): Promise<Map<string, FinderMeta>> => {
  const bookable = await materialCatalog(db, lang);
  const meta = new Map<string, FinderMeta>();
  for (const r of await getResources(db, lang)) {
    if (!r.retired) meta.set(r.uuid, { kind: 'resource', name: r.name, type: null, typeLabel: null, size: null, gradeLetter: null, bookable: bookable.has(r.uuid) });
  }
  for (const i of await getItems(db, lang)) {
    if (i.retired) continue;
    const b = bookable.get(i.uuid);
    meta.set(i.uuid, {
      kind: 'item', name: i.name, type: i.type,
      // FPS gear names its sub type too ("Helmets · Light"), as the other lists do
      typeLabel: isFpsType(i.type, i.subType) && i.subTypeLabel ? `${i.typeLabel} · ${i.subTypeLabel}` : i.typeLabel,
      // Bookable gear: the stock list's size (FPS gear has none)
      size: b ? b.size : i.size, gradeLetter: i.gradeLetter, bookable: b !== undefined,
    });
  }
  return meta;
});

/** Pure: the finder's items (every known, not retired material with an offer), sorted by name. */
export function tradeItems(data: ReadonlyMap<string, MaterialTrade>, meta: ReadonlyMap<string, FinderMeta>): TradeItem[] {
  const items: TradeItem[] = [];
  for (const [uuid, m] of data) {
    const info = meta.get(uuid);
    if (info && (m.sell.length || m.buy.length)) items.push({ uuid, ...info, ...bestPrices(m) });
  }
  return items.sort((a, b) => a.name.localeCompare(b.name) || a.uuid.localeCompare(b.uuid));
}

// Per language: rebuilt when the trade snapshot or the catalog changes
const itemsCache = new Map<string, { data: unknown; meta: unknown; items: TradeItem[] }>();

export function registerTradeRoutes(api: Hono<Env>, db: Db) {
  api.get('/trade/items', async (c) => {
    const lang = c.req.query('lang') === 'de' ? 'de' : 'en';
    const [data, meta] = [await tradeData(db), await finderMeta(db, lang)];
    let cached = itemsCache.get(lang);
    if (!cached || cached.data !== data || cached.meta !== meta) itemsCache.set(lang, (cached = { data, meta, items: tradeItems(data, meta) }));
    return c.json({ items: cached.items } satisfies TradeItemsResponse);
  });

  // Only what can be booked (the stock lists' materials)
  api.get('/trade/prices', async (c) => {
    const [data, materials] = [await tradeData(db), await materialCatalog(db, 'en')];
    const prices: Record<string, PriceSummary> = {};
    for (const uuid of materials.keys()) {
      const found = data.get(uuid);
      if (found) prices[uuid] = found.summary;
    }
    return c.json({ prices } satisfies TradePricesResponse);
  });

  api.get('/trade/:uuid', async (c) => {
    const uuid = c.req.param('uuid');
    if (!UUID.test(uuid)) throw new HttpError(400, 'invalid');
    const found = (await tradeData(db)).get(uuid);
    if (!found) throw new HttpError(404, 'notFound');
    return c.json({ prices: found.summary, sell: found.sell.map(toOffer), buy: found.buy.map(toOffer) } satisfies TradeResponse);
  });
}

interface SubjectSum {
  guildId: string | null;
  uuid: string;
  component: boolean;
  total: string;
}

/** Pure: the stored amounts at the best sell price (whole aUEC); amounts without a price do not count. */
export function stockValue(sums: Array<Pick<SubjectSum, 'uuid' | 'component' | 'total'>>, bestSell: (uuid: string) => number | undefined): StockValue {
  let resources = 0n;
  let components = 0n;
  for (const s of sums) {
    const price = bestSell(s.uuid);
    if (price === undefined) continue;
    const micros = valueMicros(formatAmount(s.total), price);
    if (s.component) components += micros;
    else resources += micros;
  }
  return { total: String(wholeOfMicros(resources + components)), resources: String(wholeOfMicros(resources)), components: String(wholeOfMicros(components)) };
}

/**
 * The overview's total values: your stored batches (shared or not) and, per org, what its active members
 * shared there (the batches orgMetrics counts). null each without any UEX prices.
 */
export async function stockValues(db: Db, userId: string, guildIds: string[]): Promise<{ personal: StockValue | null; orgs: Map<string, StockValue | null> }> {
  const data = await tradeData(db);
  if (!data.size) return { personal: null, orgs: new Map(guildIds.map((g) => [g, null])) };
  const bestSell = (uuid: string) => data.get(uuid)?.summary.sell?.max;
  const subject = sql`coalesce(b.resource_uuid, b.item_uuid)`;
  // One subject is one kind: a ship component or not
  const component = sql`bool_or(${componentItemSql('b.item_uuid')})`;
  const personal = await rows<SubjectSum>(db, sql`
    SELECT NULL AS "guildId", ${subject} AS uuid, ${component} AS component, sum(b.quantity)::text AS total
    FROM app.stock_batch b
    WHERE b.state = 'stored' AND b.owner_user_id = ${userId}
    GROUP BY 2`);
  const shared = guildIds.length ? await rows<SubjectSum>(db, sql`
    SELECT sh.guild_id AS "guildId", ${subject} AS uuid, ${component} AS component, sum(b.quantity)::text AS total
    FROM app.stock_share sh
    JOIN app.stock_batch b ON b.id = sh.batch_id AND b.state = 'stored'
    JOIN app.member m ON m.guild_id = sh.guild_id AND m.user_id = b.owner_user_id AND m.active
    WHERE sh.guild_id IN (${sql.join(guildIds.map((g) => sql`${g}`), sql`, `)})
    GROUP BY 1, 2`) : [];
  return {
    personal: stockValue(personal, bestSell),
    orgs: new Map(guildIds.map((g) => [g, stockValue(shared.filter((s) => s.guildId === g), bestSell)])),
  };
}
