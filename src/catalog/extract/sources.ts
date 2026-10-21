// Where blueprints come from, derived from the contract and scenario records: the reward pools are the
// only link (a contract hands one out on completion or on accept; an event's progress hands them out per
// point tier). Contracts not for release are left out; sub-contracts and TemporaryBlueprint modifiers
// carry no pools of their own (checked against the whole DataCore for 4.10.2).
import { locKey } from './localization.ts';
import { isObj, recordKey, refPath, type Obj, type RecordStore } from './records.ts';
import type { BlueprintSource } from '../snapshot.ts';

export const SOURCE_PATHS = {
  pools: 'libs/foundry/records/crafting/blueprintrewards/',
  generators: 'libs/foundry/records/contracts/contractgenerator/',
  scenarioProgress: 'libs/foundry/records/contracts/contractscenarios/',
};

// Handler lists that hold contracts
const CONTRACT_LISTS = ['contracts', 'introContracts', 'legacyContracts', 'PVPBountyContract'];

const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const objs = (v: unknown): Obj[] => arr(v).filter(isObj);

/** "RoX_ScenarioProgress", "ORS_MissionScenario", "CleanAir_Scenario" -> "RoX", "ORS", "CleanAir" */
export const eventKey = (key: string): string => key.replace(/_?(Mission)?Scenario(Progress)?$/i, '') || key;

interface Pool { uuid: string; key: string; total: number; weights: Map<string, number> }

type Base = Omit<BlueprintSource, 'blueprintUuid' | 'poolUuid' | 'poolKey' | 'weight' | 'poolWeight'>;

export function blueprintSources(
  store: RecordStore,
  blueprintUuidByPath: Map<string, string>,
  anomaly: (code: string, record: string | null, detail: string) => void,
): BlueprintSource[] {
  // --- reward pools: blueprint -> weight (duplicates add up), the pool's total weight ---
  const pools = new Map<string, Pool>();
  for (const path of store.list(SOURCE_PATHS.pools)) {
    const r = store.get(path)!;
    const pool: Pool = { uuid: r._RecordId_, key: recordKey(r._RecordName_), total: 0, weights: new Map() };
    for (const e of objs(r._RecordValue_.blueprintRewards)) {
      const uuid = blueprintUuidByPath.get(refPath(e.blueprintRecord) ?? '');
      const weight = num(e.weight) ?? 0;
      if (!uuid) {
        if (e.blueprintRecord == null) anomaly('invalid_value', r._RecordName_, 'pool entry without blueprint skipped');
        else anomaly('unresolved_ref', r._RecordName_, `pool entry: ${String(e.blueprintRecord)}`);
        continue;
      }
      pool.total += weight;
      pool.weights.set(uuid, (pool.weights.get(uuid) ?? 0) + weight);
    }
    pools.set(path, pool);
  }

  const out = new Map<string, BlueprintSource>();
  const add = (poolRef: unknown, base: Base, from: string) => {
    const pool = pools.get(refPath(poolRef) ?? '');
    if (!pool) return anomaly('unresolved_ref', from, `blueprint pool: ${String(poolRef)}`);
    for (const [blueprintUuid, weight] of pool.weights) {
      const key = [blueprintUuid, base.kind, base.contractId ?? base.eventKey, base.minPoints, pool.uuid].join('|');
      if (!out.has(key)) out.set(key, { blueprintUuid, ...base, poolUuid: pool.uuid, poolKey: pool.key, weight, poolWeight: pool.total });
    }
  };

  const record = (ref: unknown, from: string, what: string) => {
    if (!str(ref)) return null;
    const r = store.get(refPath(ref));
    if (!r) anomaly('unresolved_ref', from, `${what}: ${String(ref)}`);
    return r;
  };
  const stringParam = (params: unknown, name: string): string | null =>
    str(objs(isObj(params) ? params.stringParamOverrides : null).find((p) => p.param === name)?.value);

  // --- contracts ---
  for (const path of store.list(SOURCE_PATHS.generators)) {
    const generator = store.get(path)!;
    for (const h of objs(generator._RecordValue_.generators)) {
      if (h.notForRelease === true) continue;
      for (const c of CONTRACT_LISTS.flatMap((list) => objs(h[list]))) {
        const rewards = objs(isObj(c.contractResults) ? c.contractResults.contractResults : null).filter((x) => x._Type_ === 'BlueprintRewards');
        if (c.notForRelease === true || rewards.length === 0) continue;
        const from = `${generator._RecordName_}: ${str(c.debugName) ?? str(c.id) ?? '?'}`;
        const template = record(c.template, from, 'template')?._RecordValue_;
        const display = isObj(template?.contractDisplayInfo) ? template.contractDisplayInfo : {};
        const params = c.paramOverrides;
        const missionType = record(
          (isObj(params) ? params.missionTypeOverride : null) ?? (isObj(h.contractParams) ? h.contractParams.missionTypeOverride : null) ?? display.type,
          from, 'mission type')?._RecordValue_;
        const faction = record(c.factionReputation ?? h.factionReputation, from, 'faction');
        const standing = record(c.minStanding ?? h.minStanding, from, 'min standing')?._RecordValue_;
        const prerequisites = [...objs(isObj(h.defaultAvailability) ? h.defaultAvailability.prerequisites : null), ...objs(c.additionalPrerequisites)];
        const starMapUuids = (refs: unknown[]) => refs.flatMap((ref) => {
          const r = record(ref, from, 'location');
          return r?._RecordValue_._Type_ === 'StarMapObject' ? [r._RecordId_] : [];
        });
        const localityUuids = prerequisites.filter((p) => p._Type_ === 'ContractPrerequisite_Locality')
          .flatMap((p) => starMapUuids(arr(record(p.localityAvailable, from, 'locality')?._RecordValue_.availableLocations)));
        const locationUuids = starMapUuids(prerequisites.filter((p) => p._Type_ === 'ContractPrerequisite_Location').map((p) => p.locationAvailable));
        // Only a scenario started by hand (schedule off) makes it an event: RCD's run all the time
        const scenario = [...arr(h.required_active_scenarios), ...arr(c.required_active_scenarios)]
          .map((ref) => record(ref, from, 'scenario'))
          .find((s) => isObj(s?._RecordValue_.schedule) && s._RecordValue_.schedule.enabled === false);
        const base: Base = {
          kind: 'mission',
          contractId: str(c.id),
          contractKey: str(c.debugName),
          titleKey: locKey(stringParam(params, 'Title') ?? stringParam(h.contractParams, 'Title')),
          missionTypeKey: locKey(missionType?.LocalisedTypeName),
          factionUuid: faction?._RecordId_ ?? null,
          factionNameKey: locKey(faction?._RecordValue_.displayName),
          minRankNameKey: locKey(standing?.displayName),
          minReputation: num(standing?.minReputation),
          localityUuids: [...new Set(localityUuids)],
          locationUuids: [...new Set(locationUuids)],
          requiresPrevious: prerequisites.some((p) => p._Type_ === 'ContractPrerequisite_CompletedContractTags'),
          illegal: display.illegal === true,
          chance: null,
          onAccept: false,
          eventKey: scenario ? eventKey(recordKey(scenario._RecordName_)) : null,
          minPoints: null,
        };
        for (const reward of rewards) {
          // missionResults: [0] completed, [1] accepted (the rest: failed, abandoned, …)
          const results = arr(reward.missionResults);
          add(reward.blueprintPool, { ...base, chance: num(reward.chance), onAccept: results[0] !== true && results[1] === true }, from);
        }
      }
    }
  }

  // --- event progress: pools per point tier ---
  for (const path of store.list(SOURCE_PATHS.scenarioProgress)) {
    const r = store.get(path)!;
    if (r._RecordValue_._Type_ !== 'ScenarioProgress') continue;
    const tiers: Obj[] = [];
    const walk = (v: unknown) => {
      if (Array.isArray(v)) v.forEach(walk);
      else if (isObj(v)) {
        if (v._Type_ === 'STierReward') tiers.push(v);
        else Object.values(v).forEach(walk);
      }
    };
    walk(r._RecordValue_);
    for (const tier of tiers) {
      for (const poolRef of arr(tier.blueprintPool)) {
        add(poolRef, {
          kind: 'event', contractId: null, contractKey: null, titleKey: null, missionTypeKey: null, factionUuid: null,
          factionNameKey: null, minRankNameKey: null, minReputation: null, localityUuids: [], locationUuids: [],
          requiresPrevious: false, illegal: false, chance: null, onAccept: false,
          eventKey: eventKey(recordKey(r._RecordName_)), minPoints: num(tier.minPoints),
        }, r._RecordName_);
      }
    }
  }

  return [...out.values()].sort((a, b) => a.blueprintUuid.localeCompare(b.blueprintUuid) || a.kind.localeCompare(b.kind)
    || (a.contractKey ?? a.eventKey ?? '').localeCompare(b.contractKey ?? b.eventKey ?? '') || (a.minPoints ?? 0) - (b.minPoints ?? 0)
    || a.poolKey.localeCompare(b.poolKey));
}
