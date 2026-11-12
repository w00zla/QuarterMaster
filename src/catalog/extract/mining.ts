// What can be mined where, from the harvestable provider presets (one spawn table per planet, moon or
// asteroid field): groups per mining method, weighted rocks, each rock's composition of mineable elements
// and their resources. Where a provider is used comes from the object containers (socpak.ts).
import { isObj, recordKey, refPath, type Obj, type RecordStore } from './records.ts';
import type { ContainerScan } from './socpak.ts';
import type { Location, Mineable, MineableRock, MiningProvider, Resource } from '../snapshot.ts';

export const MINING_PATHS = {
  providers: 'libs/foundry/records/harvestable/providerpresets/',
  qualityDistributions: 'libs/foundry/records/crafting/qualitydistribution/',
  qualityQuantization: 'libs/foundry/records/crafting/qualityquantization/',
};

// Provider group -> mining method; the other groups (salvage, plants) are no mining
const METHODS: Record<string, Mineable['method']> = {
  SpaceShip_Mineables: 'ship',
  GroundVehicle_Mineables: 'roc',
  FPS_Mineables: 'fps',
};

// Providers whose containers carry no star map record (checked on build 12913470): the location by key
const PROVIDER_LOCATIONS: Record<string, string> = {
  HPP_Nyx_GlaciemRing: 'AsteroidCluster_Nyx_Glaciem',
  HPP_Nyx_KeegerBelt: 'AsteroidCluster_Nyx_Keeger',
  HPP_Pyro_AkiroCluster: 'Pyro_AkiroCluster',
};

const RARITY = /(uncommon|common|rare|epic|legendary)shipmineables/i;

// A rock's radar signature: the slot of its base signatures that mineable rocks set (the only non-zero one on
// build 12913470; the slot's name is not in the data). The scanner shows it times the cluster's nodes.
const RADAR_SIGNATURE = 4;

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const objs = (v: unknown): Obj[] => arr(v).filter(isObj);

interface Part { resourceUuid: string; min: number; max: number; chance: number; scale: number }
interface Rock {
  path: string; parts: Part[]; itemUuid: string | null;
  // The entity; the resource it is named after (its composition's first part); its radar signature
  uuid: string; key: string; resourceUuid: string | null; radarSignature: number | null;
}
interface Normal { min: number; max: number; mean: number; stddev: number }
interface Band { start: number; end: number; mappedValue: number }

/** The normal CDF (Abramowitz–Stegun 7.1.26, error below 1.5e-7). */
function phi(x: number): number {
  const z = Math.abs(x) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * z);
  const erf = 1 - t * (0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429)))) * Math.exp(-z * z);
  return x >= 0 ? (1 + erf) / 2 : (1 - erf) / 2;
}

/**
 * The quality values a part spawns with and their chances: Q from the normal distribution cut to min … max
 * and rounded, the part's quality = int(Q × qualityScale), then the band holding it maps it to its value (the
 * game spawns only these). Without bands only the range is known (values empty).
 */
export function partQuality(d: Normal, scale: number, bands: Band[]): Mineable['quality'] {
  const weights = new Map<number, number>();
  let total = 0;
  for (let q = Math.ceil(d.min); q <= Math.floor(d.max); q++) {
    const w = d.stddev > 0 ? phi((q + 0.5 - d.mean) / d.stddev) - phi((q - 0.5 - d.mean) / d.stddev) : (q === Math.round(d.mean) ? 1 : 0);
    if (!(w > 0)) continue;
    const scaled = Math.min(1000, Math.max(0, Math.trunc(q * scale)));
    const band = bands.find((b) => scaled >= b.start && scaled <= b.end && b.mappedValue >= b.start && b.mappedValue <= b.end);
    const value = band ? band.mappedValue : scaled;
    weights.set(value, (weights.get(value) ?? 0) + w);
    total += w;
  }
  if (!(total > 0)) return null;
  const all = [...weights.keys()].sort((a, b) => a - b);
  return {
    min: all[0]!, max: all.at(-1)!,
    values: bands.length ? all.map((value) => ({ value, chance: Math.round((weights.get(value)! / total) * 10000) / 10000 })) : [],
  };
}

export function mining(
  store: RecordStore,
  containers: ContainerScan,
  locations: Location[],
  resources: Resource[],
  itemUuids: Set<string>,
  anomaly: (code: string, record: string | null, detail: string) => void,
): { miningProviders: MiningProvider[]; mineables: Mineable[]; mineableRocks: MineableRock[] } {
  const locationByKey = new Map(locations.map((l) => [l.key, l.uuid]));
  const parentOf = new Map(locations.map((l) => [l.uuid, l.parentUuid]));
  const resourceByUuid = new Map(resources.map((r) => [r.uuid, r]));
  const places = containers.places;
  const placedByKey = new Set<string>();

  // --- rocks: entity -> composition -> elements -> resources ---
  const rocks = new Map<string, Rock | null>();
  const rockOf = (presetRef: unknown, from: string): Rock | null => {
    const presetPath = refPath(presetRef);
    if (!presetPath) return null;
    if (rocks.has(presetPath)) return rocks.get(presetPath)!;
    let rock: Rock | null = null;
    const preset = store.get(presetPath);
    const entity = store.get(refPath(preset?._RecordValue_.entityClass));
    const components = objs(entity?._RecordValue_.Components);
    const compositionRef = components.find((c) => c._Type_ === 'MineableParams')?.composition;
    const composition = store.get(refPath(compositionRef));
    if (!preset || !entity || !composition) {
      anomaly('unresolved_ref', from, `rock ${presetPath}: ${!preset ? 'preset' : !entity ? 'entity' : 'composition'} missing`);
    } else {
      // The item the rock breaks into (FPS and ROC rocks), if the catalog has it
      const itemRef = components.map((c) => (isObj(c.entityClassOverride) ? c.entityClassOverride.entityClass : null)).find((r) => r);
      const item = store.get(refPath(itemRef));
      const resolved = objs(composition._RecordValue_.compositionArray).map((e): Part | null => {
        const element = store.get(refPath(e.mineableElement));
        const rt = element?._RecordValue_.resourceType;
        const resourceUuid = isObj(rt) && typeof rt._RecordId_ === 'string' ? rt._RecordId_ : null;
        const min = num(e.minPercentage), max = num(e.maxPercentage);
        if (!resourceUuid || !resourceByUuid.has(resourceUuid) || min === null || max === null) {
          anomaly('unresolved_ref', composition._RecordName_, `element ${String(e.mineableElement)}`);
          return null;
        }
        // The chance the part is in a rock; its quality factor (the lean part of an ore: 0.49, 0.789)
        return { resourceUuid, min, max, chance: num(e.probability) ?? 1, scale: num(e.qualityScale) ?? 1 };
      });
      const signature = components.find((c) => c._Type_ === 'SSCSignatureSystemParams');
      const radar = isObj(signature?.radarProperties) ? signature.radarProperties.baseSignatureParams : null;
      rock = {
        path: refPath(compositionRef)!, parts: resolved.filter((p) => p !== null),
        itemUuid: item && itemUuids.has(item._RecordId_) ? item._RecordId_ : null,
        // The first part is the rock's own resource (every placed rock on build 12913470: the ore or gem its
        // composition's depositName names)
        uuid: entity._RecordId_, key: recordKey(entity._RecordName_), resourceUuid: resolved[0]?.resourceUuid ?? null,
        radarSignature: num(arr(isObj(radar) ? radar.signatures : null)[RADAR_SIGNATURE]),
      };
    }
    rocks.set(presetPath, rock);
    return rock;
  };

  // --- quality: the resource's distribution, a system's override where the provider lies in it ---
  const distributions = new Map<string, Obj>();
  for (const path of store.list(MINING_PATHS.qualityDistributions)) {
    const r = store.get(path)!;
    distributions.set(r._RecordId_, r._RecordValue_);
  }
  const bandsOf = new Map<string, Band[]>();
  for (const path of store.list(MINING_PATHS.qualityQuantization)) {
    const r = store.get(path)!;
    const q = r._RecordValue_.qualityQuantization;
    bandsOf.set(r._RecordId_, objs(isObj(q) ? q.bands : null).flatMap((b) => {
      const [start, end, mappedValue] = [num(b.start), num(b.end), num(b.mappedValue)];
      return start === null || end === null || mappedValue === null ? [] : [{ start, end, mappedValue }];
    }));
  }
  const normal = (d: unknown): Normal | null => {
    if (!isObj(d) || d._Type_ !== 'CraftingQualityDistributionNormal') return null;
    const [min, max, mean, stddev] = [num(d.min), num(d.max), num(d.mean), num(d.stddev)];
    return min === null || max === null || mean === null || stddev === null ? null : { min, max, mean, stddev };
  };
  // A place's ancestors; the system's star also stands for its solar system record (PyroStar ->
  // PyroSolarSystem: a root of its own, where the quality overrides point)
  const keyOf = new Map(locations.map((l) => [l.uuid, l.key]));
  const ancestors = (uuid: string) => {
    const out = new Set<string>();
    for (let u: string | null | undefined = uuid; u && !out.has(u); u = parentOf.get(u)) {
      out.add(u);
      const system = locationByKey.get(keyOf.get(u)?.replace(/Star$/, 'SolarSystem') ?? '');
      if (system && /Star$/.test(keyOf.get(u) ?? '')) out.add(system);
    }
    return out;
  };
  const qualityOf = (resourceUuid: string, scale: number, around: Set<string>): Mineable['quality'] => {
    const data = resourceByUuid.get(resourceUuid)?.craftingData[0];
    if (!data?.qualityDistributionUuid) return null;
    const override = data.qualityLocationOverrideUuid ? distributions.get(data.qualityLocationOverrideUuid) : undefined;
    const list = isObj(override?.locationOverride) ? objs(override.locationOverride.locationOverrideList) : [];
    const hit = list.find((o) => around.has(store.get(refPath(o.location))?._RecordId_ ?? ''));
    const d = normal(hit ? hit.qualityDistribution : distributions.get(data.qualityDistributionUuid)?.qualityDistribution);
    return d && partQuality(d, scale, bandsOf.get(data.qualityQuantizationUuid ?? '') ?? []);
  };

  // --- providers ---
  const miningProviders: MiningProvider[] = [];
  const mineables: Mineable[] = [];
  // The rock kinds the placed providers spawn; a rock without its own resource (unresolved) is left out
  const mineableRocks = new Map<string, MineableRock>();
  const useRock = (rock: Rock, method: Mineable['method'], from: string) => {
    if (!rock.resourceUuid) return;
    const known = mineableRocks.get(rock.uuid);
    if (known) {
      if (known.method !== method) anomaly('rock_methods', from, `rock ${rock.key} in ${known.method} and ${method}; kept ${known.method}`);
      return;
    }
    mineableRocks.set(rock.uuid, {
      uuid: rock.uuid, key: rock.key, method, resourceUuid: rock.resourceUuid,
      rarity: RARITY.exec(rock.path)?.[1]?.toLowerCase() ?? null, radarSignature: rock.radarSignature,
    });
  };
  for (const path of store.list(MINING_PATHS.providers)) {
    const r = store.get(path)!;
    const key = recordKey(r._RecordName_);
    const groups = objs(r._RecordValue_.harvestableGroups).filter((g) => typeof g.groupName === 'string' && METHODS[g.groupName]);
    if (!groups.length) continue;
    const fallback = locationByKey.get(PROVIDER_LOCATIONS[key] ?? '');
    const locationUuids = [...(places.get(r._RecordId_) ?? (fallback ? [fallback] : []))].sort();
    // Providers no container places (unused presets, unreleased systems) are left out
    if (!locationUuids.length) {
      anomaly('unplaced_provider', r._RecordName_, 'mining provider without a star map object; left out');
      continue;
    }
    if (!places.has(r._RecordId_)) placedByKey.add(r._RecordId_);
    miningProviders.push({ uuid: r._RecordId_, key, locationUuids });
    // Ancestors of every location: a system's quality override applies to all of them
    const around = new Set(locationUuids.flatMap((u) => [...ancestors(u)]));

    // Per method, resource and quality factor (a rock's rich and lean part of an ore stay apart)
    const byPart = new Map<string, Mineable>();
    for (const g of groups) {
      const method = METHODS[g.groupName as string]!;
      const harvestables = objs(g.harvestables);
      const total = harvestables.reduce((s, h) => s + (num(h.relativeProbability) ?? 0), 0);
      if (!(total > 0)) continue;
      for (const h of harvestables) {
        const rock = rockOf(h.harvestable, r._RecordName_);
        const weight = num(h.relativeProbability) ?? 0;
        if (!rock || !(weight > 0)) continue;
        useRock(rock, method, r._RecordName_);
        // A part listed twice in one rock (same resource and factor): in the rock when either is
        const inRock = new Map<string, { part: Part; missing: number; min: number; max: number }>();
        for (const p of rock.parts) {
          const k = `${p.resourceUuid}|${p.scale}`;
          const found = inRock.get(k);
          if (found) inRock.set(k, { ...found, missing: found.missing * (1 - p.chance), min: Math.min(found.min, p.min), max: Math.max(found.max, p.max) });
          else inRock.set(k, { part: p, missing: 1 - p.chance, min: p.min, max: p.max });
        }
        for (const { part, missing, min, max } of inRock.values()) {
          const k = `${method}|${part.resourceUuid}|${part.scale}`;
          const m = byPart.get(k) ?? {
            providerUuid: r._RecordId_, method, resourceUuid: part.resourceUuid, qualityScale: part.scale, itemUuid: null, share: 0,
            minPercent: min, maxPercent: max, rarity: null, quality: qualityOf(part.resourceUuid, part.scale, around),
          };
          // Rocks of this kind, times the chance the part is in one
          m.share += (weight / total) * (1 - missing);
          m.minPercent = Math.min(m.minPercent, min);
          m.maxPercent = Math.max(m.maxPercent, max);
          m.itemUuid ??= rock.itemUuid;
          m.rarity ??= RARITY.exec(rock.path)?.[1]?.toLowerCase() ?? null;
          byPart.set(k, m);
        }
      }
    }
    for (const m of byPart.values()) mineables.push({ ...m, share: Math.round(m.share * 10000) / 10000 });
  }
  // Containers with no star map record above them (an unreleased system, an area without its own object):
  // reported unless their providers got their place by key
  const providerKeys = new Map(miningProviders.map((p) => [p.uuid, p.key]));
  for (const u of containers.unplaced) {
    if (u.providers.every((p) => placedByKey.has(p))) continue;
    const names = u.providers.map((p) => providerKeys.get(p) ?? p).join(', ');
    anomaly('unplaced_container', u.container, `object container without a star map record uses ${names}`);
  }
  miningProviders.sort((a, b) => a.key.localeCompare(b.key));
  mineables.sort((a, b) => a.providerUuid.localeCompare(b.providerUuid) || a.method.localeCompare(b.method) || a.resourceUuid.localeCompare(b.resourceUuid)
    || b.qualityScale - a.qualityScale);
  return { miningProviders, mineables, mineableRocks: [...mineableRocks.values()].sort((a, b) => a.key.localeCompare(b.key)) };
}
