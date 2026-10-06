// Refinery locations and yield bonuses from the latest UEX yields snapshot. UEX has its own IDs and
// names: a terminal is matched to a selectable catalog location by English name within the same
// system, an ore to a bookable catalog ore by its normalized English name.
import { sql } from 'drizzle-orm';
import type { Db } from '../db/client.ts';
import { one } from '../db/query.ts';
import { locationCatalog, materialCatalog, type LocationEntry, type MaterialEntry } from '../stock/lookup.ts';

export interface UexTerminal {
  id: number;
  name: string;
  system: string;
  // The station, city or outpost as UEX names it ("Nyx Gateway (Pyro)", "Checkmate Station")
  place: string;
}

export interface RefineryMatch {
  // Catalog location UUID -> its UEX terminal
  matched: Map<string, UexTerminal>;
  unmatched: UexTerminal[];
  // Catalog location UUID -> ore UUID -> yield bonus in %
  yields: Map<string, Map<string, number>>;
}

type YieldRow = Record<string, unknown>;
const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);

/** The distinct terminals of a refineries_yields `data` array. */
export function uexTerminals(data: YieldRow[]): UexTerminal[] {
  const byId = new Map<number, UexTerminal>();
  for (const r of data) {
    const place = str(r.space_station_name) ?? str(r.city_name) ?? str(r.outpost_name);
    const system = str(r.star_system_name);
    if (typeof r.id_terminal !== 'number' || !place || !system || byId.has(r.id_terminal)) continue;
    byId.set(r.id_terminal, { id: r.id_terminal, name: str(r.terminal_name) ?? place, system, place });
  }
  return [...byId.values()];
}

/** Pure: matches terminals to English location entries (name + system; "(System)" and a trailing "Station" dropped). */
export function matchRefineries(terminals: UexTerminal[], locations: Iterable<LocationEntry>): RefineryMatch {
  const key = (name: string, system: string) => `${name.toLowerCase()}|${system.toLowerCase()}`;
  const byKey = new Map<string, string>();
  for (const l of locations) if (l.system) byKey.set(key(l.nameEn, l.system), l.uuid);
  const result: RefineryMatch = { matched: new Map(), unmatched: [], yields: new Map() };
  for (const t of terminals) {
    const name = t.place.replace(/\s*\([^)]*\)$/, '');
    const uuid = byKey.get(key(name, t.system)) ?? byKey.get(key(name.replace(/\s+Station$/i, ''), t.system));
    if (uuid) result.matched.set(uuid, t);
    else result.unmatched.push(t);
  }
  return result;
}

/** "Hephaestanite (R)", "Raw Ice", "Construction Material Rubble" -> "hephaestanite", "ice", "constructionrubble" */
export const oreKey = (name: string) => name.toLowerCase().replace(/\((ore|raw|r)\)/g, '').replace(/\b(raw|material)\b/g, '').replace(/[^a-z0-9]/g, '');

/** Pure: fills `match.yields` from the yields rows; ores by `oreKey` of their English name. */
export function matchYields(data: YieldRow[], match: RefineryMatch, materials: Iterable<MaterialEntry>): void {
  const ores = new Map<string, string>();
  for (const m of materials) if (m.isOre) ores.set(oreKey(m.nameEn), m.uuid);
  const location = new Map([...match.matched].map(([uuid, t]) => [t.id, uuid]));
  for (const r of data) {
    const uuid = location.get(r.id_terminal as number);
    const ore = typeof r.commodity_name === 'string' ? ores.get(oreKey(r.commodity_name)) : undefined;
    if (!uuid || !ore || typeof r.value !== 'number') continue;
    if (!match.yields.has(uuid)) match.yields.set(uuid, new Map());
    match.yields.get(uuid)!.set(ore, r.value);
  }
}

let cached: { snapshotId: number; locations: Map<string, LocationEntry>; materials: Map<string, MaterialEntry>; value: RefineryMatch } | null = null;

/** Matched refinery terminals of the latest yields snapshot; null while there is none. */
export async function refineryMatch(db: Db): Promise<RefineryMatch | null> {
  const latest = await one<{ id: number }>(db, sql`
    SELECT id::int AS id FROM ext.snapshot WHERE source = 'uex' AND endpoint = 'refineries_yields' ORDER BY id DESC LIMIT 1`);
  if (!latest) return null;
  // English names and systems: what UEX uses
  const [locations, materials] = [await locationCatalog(db, 'en'), await materialCatalog(db, 'en')];
  if (cached?.snapshotId === latest.id && cached.locations === locations && cached.materials === materials) return cached.value;
  const snap = await one<{ data: YieldRow[] }>(db, sql`SELECT data FROM ext.snapshot WHERE id = ${latest.id}`);
  const value = matchRefineries(uexTerminals(snap?.data ?? []), locations.values());
  matchYields(snap?.data ?? [], value, materials.values());
  cached = { snapshotId: latest.id, locations, materials, value };
  return value;
}

/** Location UUIDs with a refinery; null = no UEX data yet (every selectable location counts). */
export async function refineryLocations(db: Db): Promise<Set<string> | null> {
  const match = await refineryMatch(db);
  return match ? new Set(match.matched.keys()) : null;
}
