// Pure import logic: snapshot -> rows, integrity checks, diff against the DB state, safeguards.
import { createHash } from 'node:crypto';
import type { Blueprint, Snapshot } from '../snapshot.ts';

export const ENTITY_NAMES = [
  // Foreign key order: referenced tables first
  'manufacturer', 'item', 'resource', 'blueprintCategory', 'craftedProperty', 'qualityQuantization', 'blueprint', 'location', 'rawRecord',
] as const;
export type EntityName = (typeof ENTITY_NAMES)[number];

export interface EntityRow {
  uuid: string;
  contentHash: string;
  [column: string]: unknown;
}
export type EntitySets = Record<EntityName, EntityRow[]>;

export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    return `{${Object.keys(obj).sort().filter((k) => obj[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

export function chunks<T>(list: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

export const sha256 = (data: string | Uint8Array): string => createHash('sha256').update(data).digest('hex');
const hashOf = (entity: unknown): string => sha256(stableStringify(entity));

// Numeric columns are passed as strings so Postgres NUMERIC keeps the exact value
const numeric = (n: number | null): string | null => (n === null ? null : String(n));

/** Maps snapshot entities to table rows. The content hash covers the whole snapshot entity. */
export function toEntitySets(s: Snapshot): EntitySets {
  return {
    manufacturer: s.manufacturers.map((m) => ({ ...m, contentHash: hashOf(m) })),
    item: s.items.map((i) => ({ ...i, contentHash: hashOf(i) })),
    resource: s.resources.map((r) => ({
      ...r,
      densityGPerCc: numeric(r.densityGPerCc),
      boxSizesScu: r.boxSizesScu.map(String),
      contentHash: hashOf(r),
    })),
    blueprintCategory: s.blueprintCategories.map((c) => ({ ...c, contentHash: hashOf(c) })),
    craftedProperty: s.craftedProperties.map((p) => ({ ...p, contentHash: hashOf(p) })),
    qualityQuantization: s.qualityQuantizations.map((q) => ({ ...q, contentHash: hashOf(q) })),
    // Recipe goes to the child tables, but is part of the blueprint's hash
    blueprint: s.blueprints.map((b) => {
      const { tiers: _tiers, ...row } = b;
      return { ...row, contentHash: hashOf(b) };
    }),
    location: s.locations.map((l) => ({ ...l, contentHash: hashOf(l) })),
    rawRecord: s.rawRecords.map((r) => ({ ...r, contentHash: hashOf(r) })),
  };
}

export interface BlueprintChildren {
  tiers: { blueprintUuid: string; tierIndex: number; craftSeconds: string; requiredSlots: number }[];
  slots: { blueprintUuid: string; tierIndex: number; slotIndex: number; key: string; nameKey: string | null; requiredCount: number; modifiers: unknown }[];
  inputs: {
    blueprintUuid: string; tierIndex: number; slotIndex: number; inputIndex: number; kind: string;
    resourceUuid: string | null; itemUuid: string | null; quantity: string; minQuality: number;
  }[];
}

export function blueprintChildren(blueprints: Blueprint[]): BlueprintChildren {
  const out: BlueprintChildren = { tiers: [], slots: [], inputs: [] };
  for (const b of blueprints) {
    b.tiers.forEach((t, tierIndex) => {
      out.tiers.push({ blueprintUuid: b.uuid, tierIndex, craftSeconds: String(t.craftSeconds), requiredSlots: t.requiredSlots });
      t.slots.forEach((s, slotIndex) => {
        out.slots.push({ blueprintUuid: b.uuid, tierIndex, slotIndex, key: s.key, nameKey: s.nameKey, requiredCount: s.requiredCount, modifiers: s.modifiers });
        s.inputs.forEach((i, inputIndex) => {
          out.inputs.push({
            blueprintUuid: b.uuid, tierIndex, slotIndex, inputIndex, kind: i.kind,
            resourceUuid: i.kind === 'resource' ? i.uuid : null,
            itemUuid: i.kind === 'item' ? i.uuid : null,
            quantity: String(i.quantity),
            minQuality: i.minQuality,
          });
        });
      });
    });
  }
  return out;
}

/** Blueprint sources as table rows, numbered per blueprint in snapshot order. */
export function blueprintSourceRows(s: Snapshot) {
  const index = new Map<string, number>();
  return s.blueprintSources.map((src) => {
    const sourceIndex = index.get(src.blueprintUuid) ?? 0;
    index.set(src.blueprintUuid, sourceIndex + 1);
    return {
      ...src, sourceIndex, weight: String(src.weight), poolWeight: String(src.poolWeight),
      minReputation: numeric(src.minReputation), chance: numeric(src.chance),
    };
  });
}

/** Mining providers and what they yield, as table rows. */
export function miningRows(s: Snapshot) {
  return {
    providers: s.miningProviders,
    mineables: s.mineables.map(({ quality, ...m }) => ({
      ...m, qualityScale: String(m.qualityScale), share: String(m.share), minPercent: String(m.minPercent), maxPercent: String(m.maxPercent),
      qualityMin: quality?.min ?? null, qualityMax: quality?.max ?? null, qualityValues: quality?.values ?? [],
    })),
  };
}

// --- integrity -------------------------------------------------------------------------

/** Hard errors that make a snapshot unusable. Not overridable. */
export function checkIntegrity(s: Snapshot): string[] {
  const errors: string[] = [];
  const ids = (name: string, list: { uuid: string }[]) => {
    const set = new Set<string>();
    for (const e of list) {
      if (set.has(e.uuid)) errors.push(`duplicate ${name} uuid ${e.uuid}`);
      set.add(e.uuid);
    }
    return set;
  };
  const manufacturers = ids('manufacturer', s.manufacturers);
  const items = ids('item', s.items);
  const resources = ids('resource', s.resources);
  const categories = ids('blueprint category', s.blueprintCategories);
  const properties = ids('crafted property', s.craftedProperties);
  const quantizations = ids('quality quantization', s.qualityQuantizations);
  const blueprints = ids('blueprint', s.blueprints);
  const locations = ids('location', s.locations);
  ids('raw record', s.rawRecords);

  const ref = (ok: boolean, msg: string) => { if (!ok) errors.push(msg); };
  for (const i of s.items) ref(!i.manufacturerUuid || manufacturers.has(i.manufacturerUuid), `item ${i.className}: unknown manufacturer ${i.manufacturerUuid}`);
  for (const r of s.resources) {
    ref(!r.refinedUuid || resources.has(r.refinedUuid), `resource ${r.key}: unknown refined resource ${r.refinedUuid}`);
    for (const c of r.craftingData) {
      ref(!c.qualityQuantizationUuid || quantizations.has(c.qualityQuantizationUuid), `resource ${r.key}: unknown quality quantization ${c.qualityQuantizationUuid}`);
    }
  }
  for (const b of s.blueprints) {
    ref(!b.outputItemUuid || items.has(b.outputItemUuid), `blueprint ${b.key}: unknown output item ${b.outputItemUuid}`);
    ref(!b.categoryUuid || categories.has(b.categoryUuid), `blueprint ${b.key}: unknown category ${b.categoryUuid}`);
    for (const t of b.tiers) {
      for (const sl of t.slots) {
        for (const i of sl.inputs) {
          ref((i.kind === 'resource' ? resources : items).has(i.uuid), `blueprint ${b.key}: unknown ${i.kind} ${i.uuid}`);
        }
        for (const m of sl.modifiers) ref(properties.has(m.propertyUuid), `blueprint ${b.key}: unknown crafted property ${m.propertyUuid}`);
      }
    }
  }
  for (const l of s.locations) ref(!l.parentUuid || locations.has(l.parentUuid), `location ${l.key}: unknown parent ${l.parentUuid}`);
  for (const src of s.blueprintSources) {
    const what = `blueprint source ${src.contractKey ?? src.eventKey} (${src.poolKey})`;
    ref(blueprints.has(src.blueprintUuid), `${what}: unknown blueprint ${src.blueprintUuid}`);
    for (const l of [...src.localityUuids, ...src.locationUuids]) ref(locations.has(l), `${what}: unknown location ${l}`);
  }
  const providers = new Set<string>();
  for (const p of s.miningProviders) {
    if (providers.has(p.uuid)) errors.push(`duplicate mining provider uuid ${p.uuid}`);
    providers.add(p.uuid);
    for (const l of p.locationUuids) ref(locations.has(l), `mining provider ${p.key}: unknown location ${l}`);
  }
  for (const m of s.mineables) {
    ref(providers.has(m.providerUuid), `mineable ${m.resourceUuid}: unknown mining provider ${m.providerUuid}`);
    ref(resources.has(m.resourceUuid), `mineable: unknown resource ${m.resourceUuid}`);
    ref(!m.itemUuid || items.has(m.itemUuid), `mineable ${m.resourceUuid}: unknown item ${m.itemUuid}`);
  }
  for (const [name, n] of [
    ['blueprints', s.blueprints.length], ['resources', s.resources.length], ['items', s.items.length], ['locations', s.locations.length],
  ] as const) {
    if (n === 0) errors.push(`snapshot contains no ${name}`);
  }
  if (!s.localization.en || Object.keys(s.localization.en).length === 0) errors.push('snapshot contains no English texts');
  return errors;
}

// --- diff ------------------------------------------------------------------------------

export interface ExistingRow { contentHash: string; retired: boolean }

export interface EntityDiff {
  total: number;
  activeBefore: number;
  added: string[];
  changed: string[];
  unchanged: string[];
  // Previously retired, present again
  revived: string[];
  retired: string[];
}

export function diffEntities(incoming: EntityRow[], existing: Map<string, ExistingRow>): EntityDiff {
  const d: EntityDiff = { total: incoming.length, activeBefore: 0, added: [], changed: [], unchanged: [], revived: [], retired: [] };
  const seen = new Set<string>();
  for (const row of incoming) {
    seen.add(row.uuid);
    const old = existing.get(row.uuid);
    if (!old) d.added.push(row.uuid);
    else if (old.retired) d.revived.push(row.uuid);
    else if (old.contentHash !== row.contentHash) d.changed.push(row.uuid);
    else d.unchanged.push(row.uuid);
  }
  for (const [uuid, old] of existing) {
    if (old.retired) continue;
    d.activeBefore++;
    if (!seen.has(uuid)) d.retired.push(uuid);
  }
  return d;
}

/** Diff of one localization text set (source + language): key -> text. */
export interface TextDiff {
  total: number;
  added: [key: string, value: string][];
  changed: [key: string, value: string][];
  removed: string[];
  unchanged: number;
}

export function diffTexts(incoming: Record<string, string>, existing: Map<string, string>): TextDiff {
  const d: TextDiff = { total: 0, added: [], changed: [], removed: [], unchanged: 0 };
  for (const [key, value] of Object.entries(incoming)) {
    d.total++;
    const old = existing.get(key);
    if (old === undefined) d.added.push([key, value]);
    else if (old !== value) d.changed.push([key, value]);
    else d.unchanged++;
  }
  for (const key of existing.keys()) if (!Object.hasOwn(incoming, key)) d.removed.push(key);
  return d;
}

export const textsSha256 = (texts: Record<string, string>): string => sha256(stableStringify(texts));

// --- safeguards ------------------------------------------------------------------------

export interface SafeguardOptions {
  force: boolean;
  allowDowngrade: boolean;
  // Max share of active rows per entity that may be retired / changed in one import
  maxRetireRatio: number;
  maxChangeRatio: number;
}

export interface LastImport { id: number; channel: string; gameBuild: number; snapshotSha256: string }

export interface Violation { code: string; message: string; override: '--force' | '--allow-downgrade' }

export interface SafeguardResult {
  // Same snapshot as the last import: nothing to do
  noop: boolean;
  violations: Violation[];
  warnings: string[];
}

// Ratio checks ignore tiny absolute numbers
const MIN_ABSOLUTE = 3;

export function evaluateSafeguards(input: {
  game: Snapshot['game'];
  sha256: string;
  last: LastImport | null;
  diffs: Record<EntityName, EntityDiff>;
  options: SafeguardOptions;
}): SafeguardResult {
  const { game, sha256: hash, last, diffs, options } = input;
  const result: SafeguardResult = { noop: false, violations: [], warnings: [] };
  const violate = (v: Violation, overridden: boolean) => {
    if (overridden) result.warnings.push(`${v.message} (overridden by ${v.override})`);
    else result.violations.push(v);
  };

  if (last) {
    if (last.snapshotSha256 === hash) {
      if (options.force) result.warnings.push(`snapshot already imported as #${last.id} (re-import forced)`);
      else result.noop = true;
    }
    if (game.build < last.gameBuild) {
      violate({ code: 'downgrade', message: `build ${game.build} is older than the last import (#${last.id}, build ${last.gameBuild})`, override: '--allow-downgrade' }, options.allowDowngrade);
    }
    if (game.channel !== last.channel) result.warnings.push(`channel changes from ${last.channel} to ${game.channel}`);
  }

  for (const name of ENTITY_NAMES) {
    const d = diffs[name];
    if (d.activeBefore === 0) continue;
    const retired = d.retired.length;
    if (retired >= MIN_ABSOLUTE && retired / d.activeBefore > options.maxRetireRatio) {
      violate({
        code: 'mass_retire',
        message: `${name}: ${retired} of ${d.activeBefore} active rows would be retired (${pct(retired / d.activeBefore)} > ${pct(options.maxRetireRatio)})`,
        override: '--force',
      }, options.force);
    }
    // Raw records legitimately change wholesale when CIG touches a record type
    const changed = d.changed.length;
    if (name !== 'rawRecord' && changed >= MIN_ABSOLUTE && changed / d.activeBefore > options.maxChangeRatio) {
      violate({
        code: 'mass_change',
        message: `${name}: ${changed} of ${d.activeBefore} active rows would change (${pct(changed / d.activeBefore)} > ${pct(options.maxChangeRatio)})`,
        override: '--force',
      }, options.force);
    }
  }
  return result;
}

const pct = (r: number) => `${(r * 100).toFixed(1)}%`;
