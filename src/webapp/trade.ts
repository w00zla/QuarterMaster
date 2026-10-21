// The web app's trading data (UEX prices from ext.snapshot): the info card's summary, the stock lists'
// UEC columns, the overview's total value and the trading dialog. Registered by registerRoutes.
import { sql } from 'drizzle-orm';
import type { Hono } from 'hono';
import type { Db } from '../db/client.ts';
import { rows } from '../db/query.ts';
import { tradeData, type Offer } from '../ext/trade.ts';
import { valueMicros, wholeOfMicros, formatAmount } from '../stock/amount.ts';
import { materialCatalog } from '../stock/lookup.ts';
import { componentItemSql } from '../stock/service.ts';
import type { PriceSummary, StockValue, TradeOffer, TradePricesResponse, TradeResponse } from './api-types.ts';
import { HttpError, type Env } from './routes.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const toOffer = (o: Offer): TradeOffer => ({ ...o, date: new Date(o.date * 1000).toISOString() });

export function registerTradeRoutes(api: Hono<Env>, db: Db) {
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
