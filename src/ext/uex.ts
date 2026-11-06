// UEX API (community reports): fetches refineries, terminals, commodities and the commodity and item
// prices into ext.snapshot (source `uex`); only endpoints that need no ID.
import { z } from 'zod';
import type { Db } from '../db/client.ts';
import { storeSnapshot } from './store.ts';

const UEX_SOURCE = 'uex';
const UEX_API = 'https://api.uexcorp.uk/2.0';
export const UEX_ENDPOINTS = [
  'refineries_yields', 'refineries_methods', 'terminals', 'commodities',
  'commodities_prices_all', 'commodities_raw_prices_all', 'items_prices_all',
] as const;
// Prices (and stock per terminal; commodities holds average prices) change several times a day and are
// large (items_prices_all ~6 MB): only their latest snapshot is kept
const LATEST_ONLY = new Set<string>(['commodities', 'commodities_prices_all', 'commodities_raw_prices_all', 'items_prices_all']);

const Response = z.object({ status: z.literal('ok'), data: z.array(z.record(z.string(), z.unknown())) });

/** GET one endpoint; returns its `data` array. Throws on HTTP errors and unexpected shapes. */
export async function fetchEndpoint(endpoint: string, token: string, fetchFn: typeof fetch = fetch): Promise<unknown[]> {
  const res = await fetchFn(`${UEX_API}/${endpoint}/`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`UEX ${endpoint}: HTTP ${res.status} ${text.slice(0, 200)}`);
  const parsed = Response.safeParse(JSON.parse(text));
  if (!parsed.success) throw new Error(`UEX ${endpoint}: unexpected response ${text.slice(0, 200)}`);
  return parsed.data.data;
}

export interface PullResult {
  inserted: number;
  unchanged: number;
  failed: number;
}

/** Fetches and stores every endpoint; one failing endpoint does not stop the others. */
export async function pullUex(db: Db, token: string, fetchFn: typeof fetch = fetch): Promise<PullResult> {
  const result: PullResult = { inserted: 0, unchanged: 0, failed: 0 };
  for (const endpoint of UEX_ENDPOINTS) {
    const t0 = performance.now();
    try {
      const data = await fetchEndpoint(endpoint, token, fetchFn);
      const stored = await storeSnapshot(db, UEX_SOURCE, endpoint, data, LATEST_ONLY.has(endpoint));
      result[stored]++;
      console.log(`  ${endpoint}: ${data.length} rows, ${stored} (${seconds(t0)})`);
    } catch (err) {
      result.failed++;
      console.error(`  ${endpoint}: failed (${seconds(t0)})`, err);
    }
  }
  return result;
}

const seconds = (t0: number) => `${((performance.now() - t0) / 1000).toFixed(1)} s`;
