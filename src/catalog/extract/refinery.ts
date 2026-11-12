// The refinery terminal entity: which DataCore records are placed by the object containers where a refinery is (socpak.ts).
import { isObj, type RecordStore } from './records.ts';

// Entities are exported by the CLI's DCB_FILTERS (the refinery sits directly below entities/); the scan covers all that were
export const ENTITY_PATHS = 'libs/foundry/records/entities/';
const REFINERY_COMPONENT = 'EntityComponentRefineryParams';

/** Record ids of the entities with a refinery component (build 12913470: one, `EntityClassDefinition.Refinery`). */
export function refineryEntities(store: RecordStore): string[] {
  const ids: string[] = [];
  for (const path of store.list(ENTITY_PATHS)) {
    const r = store.get(path);
    if (r?._RecordValue_._Type_ !== 'EntityClassDefinition') continue;
    const components = r._RecordValue_.Components;
    if (Array.isArray(components) && components.some((c) => isObj(c) && c._Type_ === REFINERY_COMPONENT)) ids.push(r._RecordId_);
  }
  return ids.sort();
}
