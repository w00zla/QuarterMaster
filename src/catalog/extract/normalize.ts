// Turns exported DataCore records into a catalog snapshot.
// Robust by design: unexpected shapes become anomalies, never crashes.
import { displayText, isMissingTranslation, locKey } from './localization.ts';
import { isComponentType } from '../components.ts';
import { isAppKey } from '../labels.ts';
import { isObj, recordKey, refPath, type DcbRecord, type Obj, type RecordStore } from './records.ts';
import {
  SNAPSHOT_SCHEMA_VERSION,
  type Anomaly, type Blueprint, type BlueprintCategory, type BlueprintInput, type BlueprintSlot,
  type BlueprintTier, type CraftedProperty, type Item, type Location, type Manufacturer, type ModifierRange,
  type QualityQuantization, type RawRecord, type Resource, type Snapshot,
} from '../snapshot.ts';

export const PATHS = {
  crafting: 'libs/foundry/records/crafting/',
  blueprints: 'libs/foundry/records/crafting/blueprints/crafting/',
  categories: 'libs/foundry/records/crafting/blueprintcategories/blueprintcategorydatabase.json',
  craftedProperties: 'libs/foundry/records/crafting/craftedproperties/',
  qualityQuantization: 'libs/foundry/records/crafting/qualityquantization/',
  globalParams: 'libs/foundry/records/crafting/globalparams/craftingglobalparams.json',
  resourceTypes: 'libs/foundry/records/resourcetypedatabase/resourcetypedatabase.json',
  shipItems: 'libs/foundry/records/entities/scitem/ships/',
  starmap: 'libs/foundry/records/starmap/',
  starmapTypes: 'libs/foundry/records/starmap/starmapobjecttypes.json',
};

// SResourceTypeDefaultCargoContainers field -> box size in SCU
const CARGO_BOX_SIZES: Record<string, number> = {
  one_eighthSCU: 0.125, one_quarterSCU: 0.25, one_halfSCU: 0.5, oneSCU: 1, twoSCU: 2,
  fourSCU: 4, eightSCU: 8, sixteenSCU: 16, twentyFourSCU: 24, thirtyTwoSCU: 32,
};

// Resource property types we know; only crafting data is normalized, the rest stays in raw data
const KNOWN_RESOURCE_PROPERTIES = new Set(['ResourceTypeCraftingData', 'ResourceTypeVolatility']);

export interface NormalizeInput {
  store: RecordStore;
  // Language code -> parsed global.ini
  localizations: Map<string, Map<string, string>>;
  game: Snapshot['game'];
  extractor: Snapshot['extractor'];
}

const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const int = (v: unknown): number | null => (Number.isInteger(v) ? (v as number) : null);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const type = (v: unknown): string | null => (isObj(v) ? str(v._Type_) : null);

export function normalize(input: NormalizeInput): Snapshot {
  const { store } = input;
  const anomalies: Anomaly[] = [];
  const nulls = new Map<string, number>();
  const anomaly = (code: string, record: string | null, detail: string) => anomalies.push({ code, record, detail });

  /** Non-null object entries of a list; null entries are counted per context. */
  const entries = (v: unknown, context: string): Obj[] => {
    const out: Obj[] = [];
    for (const e of arr(v)) {
      if (isObj(e)) out.push(e);
      else nulls.set(context, (nulls.get(context) ?? 0) + 1);
    }
    return out;
  };

  /** Resolves a file-path reference to the referenced record's UUID. */
  const refUuid = (ref: unknown, from: string, what: string): string | null => {
    if (ref === null || ref === undefined) return null;
    const rec = store.get(refPath(ref));
    if (!rec) anomaly('unresolved_ref', from, `${what}: ${String(ref)}`);
    return rec?._RecordId_ ?? null;
  };

  const en = input.localizations.get('en');
  const starmapPaths = store.list(PATHS.starmap);
  const rawPaths = new Set<string>([...store.list(PATHS.crafting), ...starmapPaths]);
  rawPaths.add(PATHS.resourceTypes);

  // --- resources --------------------------------------------------------------------
  const resources = new Map<string, Resource>();
  const rtdb = store.get(PATHS.resourceTypes);
  if (!rtdb) anomaly('missing_record', PATHS.resourceTypes, 'resource type database not found');

  const addResource = (rt: Obj, groupPath: string[]) => {
    const uuid = str(rt._RecordId_);
    const name = str(rt._RecordName_);
    if (!uuid || !name) return anomaly('invalid_resource', name, 'resource type without id/name');
    const existing = resources.get(uuid);
    if (existing) {
      // Inline copies (e.g. under refinedVersion) carry no group; keep the grouped entry
      if (existing.groupPath.length === 0 && groupPath.length > 0) existing.groupPath = groupPath;
      return;
    }
    const refined = rt.refinedVersion;
    if (refined !== null && !isObj(refined)) anomaly('unexpected_shape', name, 'refinedVersion is not an inline record');
    const density = isObj(rt.densityType) && isObj(rt.densityType.densityUnit) ? rt.densityType.densityUnit : null;
    if (density && density._Type_ !== 'GramsPerCubicCentimeter') anomaly('unknown_type', name, `density unit ${String(density._Type_)}`);
    const boxes: number[] = [];
    if (isObj(rt.defaultCargoContainers)) {
      for (const [field, value] of Object.entries(rt.defaultCargoContainers)) {
        if (field === '_Type_' || value === null) continue;
        const size = CARGO_BOX_SIZES[field];
        if (size === undefined) anomaly('unknown_field', name, `cargo container field ${field}`);
        else boxes.push(size);
      }
    }
    const properties = entries(rt.properties, 'resource.properties');
    const craftingData = properties
      .filter((p) => p._Type_ === 'ResourceTypeCraftingData')
      .map((p) => ({
        name: str(p.name),
        qualityDistributionUuid: isObj(p.qualityDistribution)
          ? refUuid(p.qualityDistribution.qualityDistributionRecord, name, 'qualityDistribution') : null,
        qualityLocationOverrideUuid: isObj(p.qualityLocationOverride)
          ? refUuid(p.qualityLocationOverride.locationOverrideRecord, name, 'qualityLocationOverride') : null,
        qualityQuantizationUuid: isObj(p.qualityQuantization)
          ? refUuid(p.qualityQuantization.qualityQuantizationRecord, name, 'qualityQuantization') : null,
      }));
    for (const p of properties) {
      if (!KNOWN_RESOURCE_PROPERTIES.has(String(p._Type_))) anomaly('unknown_type', name, `resource property ${String(p._Type_)}`);
    }
    resources.set(uuid, {
      uuid,
      key: recordKey(name),
      groupPath,
      nameKey: locKey(rt.displayName),
      descriptionKey: locKey(rt.description),
      isOre: isObj(refined),
      refinedUuid: isObj(refined) ? str(refined._RecordId_) : null,
      densityGPerCc: density ? num(density.gramsPerCubicCentimeter) : null,
      boxSizesScu: boxes.sort((a, b) => a - b),
      craftingData,
      // Inline refined record replaced by a reference to avoid duplicating it
      data: { ...rt, refinedVersion: isObj(refined) ? { _RecordId_: refined._RecordId_, _RecordName_: refined._RecordName_ } : null },
    });
    if (isObj(refined)) addResource(refined, []);
  };

  const walkGroups = (groups: unknown, parent: string[]) => {
    for (const g of entries(groups, 'resource.groups')) {
      const path = [...parent, recordKey(str(g._RecordName_) ?? '?')];
      for (const rt of entries(g.resources, 'resource.resources')) addResource(rt, path);
      walkGroups(g.groups, path);
    }
  };
  if (rtdb) walkGroups(rtdb._RecordValue_.groups, []);

  // --- blueprint categories, crafted properties, quality quantization ----------------
  const categories: BlueprintCategory[] = [];
  const catdb = store.get(PATHS.categories);
  if (!catdb) anomaly('missing_record', PATHS.categories, 'blueprint category database not found');
  for (const c of entries(catdb?._RecordValue_.categories, 'categories')) {
    const uuid = str(c._RecordId_);
    const name = str(c._RecordName_);
    if (uuid && name) categories.push({ uuid, key: recordKey(name) });
  }

  const craftedProperties: CraftedProperty[] = store.list(PATHS.craftedProperties).map((p) => {
    const r = store.get(p)!;
    const v = r._RecordValue_;
    return {
      uuid: r._RecordId_,
      key: recordKey(r._RecordName_),
      nameKey: locKey(v.propertyName),
      unitKey: locKey(v.unitFormat),
      displayTransformation: v.displayTransformation ?? null,
    };
  });

  const qualityQuantizations: QualityQuantization[] = store.list(PATHS.qualityQuantization).map((p) => {
    const r = store.get(p)!;
    const q = r._RecordValue_.qualityQuantization;
    const bands = entries(isObj(q) ? q.bands : null, 'quantization.bands').map((b) => ({
      start: num(b.start) ?? NaN, end: num(b.end) ?? NaN, mappedValue: num(b.mappedValue) ?? NaN,
    }));
    if (bands.some((b) => Number.isNaN(b.start + b.end + b.mappedValue))) anomaly('invalid_value', r._RecordName_, 'non-numeric quality band');
    return { uuid: r._RecordId_, key: recordKey(r._RecordName_), bands: bands.filter((b) => !Number.isNaN(b.start + b.end + b.mappedValue)) };
  });

  // --- blueprints --------------------------------------------------------------------
  const globalParams = store.get(PATHS.globalParams);
  if (!globalParams) anomaly('missing_record', PATHS.globalParams, 'crafting global params not found');
  const selection = globalParams?._RecordValue_.defaultBlueprintSelection;
  if (selection && type(selection) !== 'DefaultBlueprintSelection_Whitelist') {
    anomaly('unknown_type', PATHS.globalParams, `default blueprint selection ${String(type(selection))}`);
  }
  const defaultPaths = new Set(arr(isObj(selection) ? selection.blueprintRecords : null).map(refPath));

  const entityPaths = new Set<string>();
  const entityUuid = (ref: unknown, from: string, what: string): string | null => {
    const path = refPath(ref);
    const rec = store.get(path);
    if (!rec || !path) {
      anomaly('unresolved_ref', from, `${what}: ${String(ref)}`);
      return null;
    }
    entityPaths.add(path);
    return rec._RecordId_;
  };

  const modifierRanges = (ranges: unknown, from: string): ModifierRange[] =>
    entries(ranges, 'modifier.valueRanges').flatMap((r) => {
      const t = str(r._Type_) ?? '?';
      const values: Record<string, number> = {};
      for (const [k, v] of Object.entries(r)) {
        if (k !== 'startQuality' && k !== 'endQuality' && typeof v === 'number') values[k] = v;
      }
      if (!/_(Linear|LinearIntegerAdditive)$/.test(t)) anomaly('unknown_type', from, `modifier range ${t}`);
      const start = num(r.startQuality);
      const end = num(r.endQuality);
      if (start === null || end === null) {
        anomaly('invalid_value', from, `modifier range without quality bounds (${t})`);
        return [];
      }
      return [{ type: t.replace(/^CraftingGameplayPropertyModifierValueRange_/, ''), startQuality: start, endQuality: end, values }];
    });

  const slot = (sel: Obj, from: string): BlueprintSlot => {
    const nameInfo = isObj(sel.nameInfo) ? sel.nameInfo : {};
    const modifiers: BlueprintSlot['modifiers'] = [];
    for (const ctx of entries(sel.context, 'slot.context')) {
      if (ctx._Type_ === 'CraftingCostContext_ResultGameplayPropertyModifiers') {
        const list = isObj(ctx.gameplayPropertyModifiers) ? ctx.gameplayPropertyModifiers.gameplayPropertyModifiers : null;
        for (const m of entries(list, 'slot.modifiers')) {
          const propertyUuid = refUuid(m.gameplayPropertyRecord, from, 'gameplay property');
          if (propertyUuid) modifiers.push({ propertyUuid, ranges: modifierRanges(m.valueRanges, from) });
          else if (m.gameplayPropertyRecord == null) anomaly('invalid_value', from, 'modifier without gameplay property skipped');
        }
      } else {
        anomaly('unknown_type', from, `slot context ${String(ctx._Type_)}`);
      }
    }
    const inputs: BlueprintInput[] = [];
    for (const o of entries(sel.options, 'slot.options')) {
      const minQuality = int(o.minQuality) ?? 0;
      if (o._Type_ === 'CraftingCost_Resource') {
        const uuid = isObj(o.resource) ? str(o.resource._RecordId_) : null;
        const scu = isObj(o.quantity) ? num(o.quantity.standardCargoUnits) : null;
        if (isObj(o.quantity) && o.quantity._Type_ !== 'SStandardCargoUnit') anomaly('unknown_type', from, `quantity ${String(o.quantity._Type_)}`);
        if (!uuid || scu === null) anomaly('invalid_value', from, 'resource cost without resource/quantity');
        else if (!resources.has(uuid)) anomaly('unresolved_ref', from, `resource ${uuid} not in resource type database`);
        else inputs.push({ kind: 'resource', uuid, quantity: scu, minQuality });
      } else if (o._Type_ === 'CraftingCost_Item') {
        const uuid = entityUuid(o.entityClass, from, 'item cost');
        const count = num(o.quantity);
        if (uuid && count !== null) inputs.push({ kind: 'item', uuid, quantity: count, minQuality });
        else if (uuid) anomaly('invalid_value', from, 'item cost without quantity');
      } else {
        anomaly(o._Type_ === 'CraftingCost_Select' ? 'nested_select' : 'unknown_type', from, `slot option ${String(o._Type_)} skipped`);
      }
    }
    return {
      key: str(nameInfo.debugName) ?? '',
      nameKey: locKey(nameInfo.displayName),
      requiredCount: int(sel.count) ?? 1,
      modifiers,
      inputs,
    };
  };

  const craftSeconds = (t: unknown): number => {
    if (!isObj(t)) return 0;
    return (num(t.days) ?? 0) * 86400 + (num(t.hours) ?? 0) * 3600 + (num(t.minutes) ?? 0) * 60 + (num(t.seconds) ?? 0);
  };

  const blueprints: Blueprint[] = [];
  for (const path of store.list(PATHS.blueprints)) {
    const r = store.get(path)!;
    const from = r._RecordName_;
    const bp = r._RecordValue_.blueprint;
    if (!isObj(bp)) {
      anomaly('unexpected_shape', from, 'record without blueprint');
      continue;
    }
    const process = isObj(bp.processSpecificData) ? bp.processSpecificData : {};
    if (process._Type_ !== 'CraftingProcess_Creation') anomaly('unknown_type', from, `process ${String(process._Type_)}`);
    let outputItemUuid: string | null = null;
    if (process.entityClass) outputItemUuid = entityUuid(process.entityClass, from, 'output');
    else anomaly('no_output', from, 'blueprint has no output entity');

    const tiers: BlueprintTier[] = entries(bp.tiers, 'blueprint.tiers').map((tier) => {
      const recipe = isObj(tier.recipe) ? tier.recipe : {};
      const costs = isObj(recipe.costs) ? recipe.costs : {};
      const root = isObj(costs.mandatoryCost) ? costs.mandatoryCost : {};
      if (arr(costs.optionalCosts).length > 0) anomaly('unhandled_data', from, 'optionalCosts present (kept in raw only)');
      if (isObj(tier.research) && (tier.research.unlockRequirements !== null || tier.research.researchCosts !== null)) {
        anomaly('unhandled_data', from, 'research data present (kept in raw only)');
      }
      const slots: BlueprintSlot[] = [];
      for (const o of entries(root.options, 'root.options')) {
        if (o._Type_ === 'CraftingCost_Select') slots.push(slot(o, from));
        else anomaly('unexpected_shape', from, `root option ${String(o._Type_)} skipped`);
      }
      return { craftSeconds: craftSeconds(costs.craftTime), requiredSlots: int(root.count) ?? slots.length, slots };
    });
    if (tiers.length !== 1) anomaly('unhandled_data', from, `${tiers.length} tiers`);

    const category = isObj(bp.category) ? str(bp.category._RecordId_) : null;
    blueprints.push({
      uuid: r._RecordId_,
      key: recordKey(from),
      categoryUuid: category && categories.some((c) => c.uuid === category) ? category : null,
      outputItemUuid,
      isDefault: defaultPaths.has(path),
      tiers,
    });
    if (category && !categories.some((c) => c.uuid === category)) anomaly('unresolved_ref', from, `category ${category}`);
  }

  // --- items and manufacturers -------------------------------------------------------
  // Besides the items the blueprints reference, every named ship item of a component type is in the
  // catalog (looted and bought components are stock too); templates are no items the game shows
  for (const path of store.list(PATHS.shipItems)) {
    if (entityPaths.has(path) || path.includes('template')) continue;
    const r = store.get(path);
    const attach = arr(r?._RecordValue_.Components).find((c) => isObj(c) && c._Type_ === 'SAttachableComponentParams');
    const def = isObj(attach) && isObj(attach.AttachDef) ? attach.AttachDef : null;
    if (!def || !isComponentType(str(def.Type))) continue;
    if (!locKey(isObj(def.Localization) ? def.Localization.Name : null)) continue;
    entityPaths.add(path);
  }
  const manufacturerPaths = new Set<string>();
  const items: Item[] = [...entityPaths].sort().map((path) => {
    const r = store.get(path)!;
    rawPaths.add(path);
    const attach = entries(r._RecordValue_.Components, 'entity.components')
      .find((c) => c._Type_ === 'SAttachableComponentParams')?.AttachDef;
    const def = isObj(attach) ? attach : {};
    if (!isObj(attach)) anomaly('unexpected_shape', r._RecordName_, 'entity without SAttachableComponentParams');
    const loc = isObj(def.Localization) ? def.Localization : {};
    let manufacturerUuid: string | null = null;
    const mPath = refPath(def.Manufacturer);
    if (mPath) {
      const m = store.get(mPath);
      if (m) {
        manufacturerPaths.add(mPath);
        manufacturerUuid = m._RecordId_;
      } else {
        anomaly('unresolved_ref', r._RecordName_, `manufacturer ${mPath}`);
      }
    }
    // Grade letter and class are only stated in the English description text
    const description = displayText(en?.get(locKey(loc.Description) ?? '') ?? '');
    return {
      uuid: r._RecordId_,
      className: recordKey(r._RecordName_),
      type: str(def.Type),
      subType: str(def.SubType),
      size: int(def.Size),
      grade: int(def.Grade),
      gradeLetter: /^Grade: ([A-D])\s*$/m.exec(description)?.[1] ?? null,
      // Some texts use other spaces (e.g. a no-break space, also right after "Class:", QuikCool):
      // normalized, so equal classes match
      itemClass: /^Class:[^\S\n]+(.+?)\s*$/m.exec(description)?.[1]?.replace(/\s+/g, ' ') ?? null,
      manufacturerUuid,
      nameKey: locKey(loc.Name),
      descriptionKey: locKey(loc.Description),
    };
  });

  const manufacturers: Manufacturer[] = [...manufacturerPaths].sort().map((path) => {
    const r = store.get(path)!;
    rawPaths.add(path);
    const v = r._RecordValue_;
    const loc = isObj(v.Localization) ? v.Localization : {};
    return {
      uuid: r._RecordId_,
      key: recordKey(r._RecordName_),
      code: str(v.Code),
      nameKey: locKey(loc.Name),
      descriptionKey: locKey(loc.Description),
    };
  });

  // --- locations ---------------------------------------------------------------------
  // Object types are inline entries of one record, referenced by their id
  const typeNames = new Map<string, string>();
  const typesRecord = store.get(PATHS.starmapTypes);
  if (!typesRecord) anomaly('missing_record', PATHS.starmapTypes, 'star map object types not found');
  for (const t of entries(typesRecord?._RecordValue_.types, 'starmap.types')) {
    const id = str(t._RecordId_);
    const name = str(t.name);
    if (id && name) typeNames.set(id, name);
  }

  const locations: Location[] = [];
  for (const path of starmapPaths) {
    const r = store.get(path)!;
    const v = r._RecordValue_;
    // Other record types (markers, special events, …) stay raw only
    if (v._Type_ !== 'StarMapObject') continue;
    const from = r._RecordName_;
    let parentUuid: string | null = null;
    if (str(v.parent)) {
      const parent = store.get(refPath(v.parent));
      if (!parent) anomaly('unresolved_ref', from, `parent: ${String(v.parent)}`);
      else if (parent._RecordValue_._Type_ !== 'StarMapObject') anomaly('unexpected_shape', from, `parent is a ${parent._RecordValue_._Type_}`);
      else parentUuid = parent._RecordId_;
    }
    const typeId = isObj(v.type) ? str(v.type._RecordId_) : null;
    const typeName = typeId ? typeNames.get(typeId) ?? null : null;
    if (typeId && !typeName) anomaly('unresolved_ref', from, `star map object type ${typeId}`);
    locations.push({
      uuid: r._RecordId_,
      key: recordKey(from),
      nameKey: locKey(v.name),
      descriptionKey: locKey(v.description),
      parentUuid,
      type: typeName,
      navIcon: str(v.navIcon),
      hideInStarmap: v.hideInStarmap === true,
      respawnLocationType: str(v.respawnLocationType),
    });
  }

  // --- raw records and localization --------------------------------------------------
  const rawRecords: RawRecord[] = [...rawPaths].sort().flatMap((path) => {
    const r: DcbRecord | null = store.get(path);
    if (!r) return [];
    return [{ uuid: r._RecordId_, name: r._RecordName_, type: r._RecordValue_._Type_, path, data: r._RecordValue_ }];
  });

  // Loc keys referenced anywhere in the stored raw data (for the coverage check)
  const keys = new Set<string>();
  const collectKeys = (v: unknown) => {
    if (typeof v === 'string') {
      const k = locKey(v);
      if (k) keys.add(k);
    } else if (Array.isArray(v)) {
      v.forEach(collectKeys);
    } else if (isObj(v)) {
      Object.values(v).forEach(collectKeys);
    }
  };
  rawRecords.forEach((r) => collectKeys(r.data));
  const localization: Snapshot['localization'] = {};
  // Complete text sets of every shipped language; placeholders count as missing
  for (const [lang, table] of input.localizations) {
    const texts: Record<string, string> = {};
    let placeholders = 0;
    let appKeys = 0;
    for (const [k, text] of [...table].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
      if (isAppKey(k)) appKeys++;
      else if (isMissingTranslation(text)) placeholders++;
      else texts[k] = displayText(text);
    }
    if (appKeys > 0) anomaly('reserved_key', null, `${lang}: ${appKeys} game keys use the app's reserved prefix; skipped`);
    localization[lang] = texts;
    if (placeholders > 0) anomaly('missing_translation', null, `${lang}: ${placeholders} "translation not found" placeholders skipped`);
  }
  const missingEn = en ? [...keys].filter((k) => !en.has(k)).length : keys.size;
  if (missingEn > 0) anomaly('missing_localization', null, `${missingEn} of ${keys.size} loc keys have no English text`);

  for (const [context, count] of [...nulls].sort()) {
    anomaly('null_entries', null, `${count} null list entries skipped in ${context}`);
  }

  return {
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    game: input.game,
    extractor: input.extractor,
    extractedAt: new Date().toISOString(),
    anomalies,
    localization,
    rawRecords,
    resources: [...resources.values()].sort((a, b) => a.key.localeCompare(b.key)),
    manufacturers,
    items,
    blueprintCategories: categories,
    craftedProperties,
    qualityQuantizations,
    blueprints,
    locations,
  };
}
