// The web app's mining data: where a resource, the ores of a refined material or a gem item is mined.
// Game data only; registered by registerRoutes. The shaping below is pure (tested without a DB).
import type { Hono } from 'hono';
import { z } from 'zod';
import type { Db } from '../db/client.ts';
import type { MiningIndexResponse, MiningPart, MiningQuality, MiningResponse, MiningRow } from './api-types.ts';
import { minedResources, mineablesOf, placeAreas, placeInfos, subjectName, type MineableRow, type PlaceInfo } from './mining-query.ts';
import { HttpError, type Env } from './routes.ts';
import { starMap, type StarMapPlace } from './unlock-query.ts';

// Places with the same layout in many spots: one row per provider with their count
const GROUPS: Array<[MiningRow['group'] & string, RegExp]> = [
  ['miningBase', /^AsteroidCluster_MiningBase_/i],
  ['qvStation', /QVExtractionStation/i],
];

const quality = (r: MineableRow): MiningQuality | null =>
  r.qualityMin === null || r.qualityMax === null ? null : { min: r.qualityMin, max: r.qualityMax, values: r.qualityValues };

/**
 * One row per place (instanced places grouped), method and ore, with the ore's parts in the rock (the rich
 * one first); the largest share first.
 */
export function miningRows(
  found: MineableRow[], names: Map<string, StarMapPlace>, infos: Map<string, PlaceInfo>, areas = new Map<string, string>(),
): MiningRow[] {
  const out = new Map<string, { row: MiningRow; places: Set<string>; scales: Set<number> }>();
  for (const r of found) {
    const part: MiningPart = {
      qualityScale: Number(r.qualityScale), share: Math.round(Number(r.share) * 1000) / 10,
      minPercent: Number(r.minPercent), maxPercent: Number(r.maxPercent), quality: quality(r),
    };
    for (const uuid of r.locationUuids) {
      const info = infos.get(uuid);
      const place = names.get(uuid);
      const group = GROUPS.find(([, re]) => re.test(info?.key ?? ''))?.[0] ?? null;
      // A moon shows its planet, a place named after nothing its area (a Nyx ring)
      const parent = areas.get(uuid) ?? (info?.type === 'Moon' && info.parent ? names.get(info.parent)?.name ?? null : null);
      const system = place?.system ?? null;
      const key = JSON.stringify([r.oreUuid, r.method, group ?? uuid, system]);
      const entry = out.get(key) ?? {
        row: { ore: r.ore, place: group ? null : place?.name ?? info?.key ?? uuid, parent, system, group, count: 0, method: r.method, share: 0, rarity: r.rarity, parts: [] },
        places: new Set<string>(), scales: new Set<number>(),
      };
      entry.places.add(uuid);
      entry.row.count = entry.places.size;
      // Grouped places share their provider: each part once
      if (!entry.scales.has(part.qualityScale)) {
        entry.scales.add(part.qualityScale);
        entry.row.parts.push(part);
        entry.row.parts.sort((a, b) => b.qualityScale - a.qualityScale);
        entry.row.share = entry.row.parts[0]!.share;
        entry.row.rarity ??= r.rarity;
      }
      out.set(key, entry);
    }
  }
  return [...out.values()].map((e) => e.row)
    .sort((a, b) => b.share - a.share || (a.place ?? '').localeCompare(b.place ?? '') || a.ore.localeCompare(b.ore));
}

const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);

export function registerMiningRoutes(api: Hono<Env>, db: Db) {
  api.get('/mining', async (c) => {
    const lang = c.req.query('lang') === 'de' ? 'de' : 'en';
    const resources = (await minedResources(db, lang)).sort((a, b) => a.name.localeCompare(b.name));
    return c.json({ resources } satisfies MiningIndexResponse);
  });

  api.get('/mining/:uuid', async (c) => {
    const id = uuid.safeParse(c.req.param('uuid'));
    if (!id.success) throw new HttpError(400, 'invalid');
    const lang = c.req.query('lang') === 'de' ? 'de' : 'en';
    const name = await subjectName(db, id.data, lang);
    if (!name) throw new HttpError(404, 'notFound');
    const rows = miningRows(await mineablesOf(db, id.data, lang), await starMap(db, lang), await placeInfos(db), await placeAreas(db, lang));
    return c.json({ name, rows } satisfies MiningResponse);
  });
}
