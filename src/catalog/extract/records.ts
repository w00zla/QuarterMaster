// Access to DataCore records exported by `starbreaker dcb extract --format json`.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export type Obj = Record<string, unknown>;

export interface DcbRecord {
  _RecordName_: string;
  _RecordId_: string;
  _RecordValue_: Obj & { _Type_: string };
}

const RECORDS_ROOT = 'libs/foundry/records/';

/** Normalizes a record reference ("file://./../../libs/foundry/records/x.json") to "libs/foundry/records/x.json". */
export function refPath(ref: unknown): string | null {
  if (typeof ref !== 'string') return null;
  const i = ref.toLowerCase().indexOf(RECORDS_ROOT);
  return i >= 0 ? ref.slice(i).toLowerCase() : null;
}

export function isObj(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** "CraftingBlueprintRecord.BP_CRAFT_X" -> "BP_CRAFT_X" */
export function recordKey(recordName: string): string {
  const dot = recordName.indexOf('.');
  return dot >= 0 ? recordName.slice(dot + 1) : recordName;
}

/** Lazily loads exported records by their (lower-case) record path. */
export class RecordStore {
  private readonly cache = new Map<string, DcbRecord | null>();
  private readonly root: string;

  constructor(root: string) {
    this.root = root;
  }

  get(path: string | null): DcbRecord | null {
    if (!path) return null;
    if (!this.cache.has(path)) {
      const file = join(this.root, path);
      this.cache.set(path, existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as DcbRecord) : null);
    }
    return this.cache.get(path) ?? null;
  }

  /** Record paths below a directory prefix (e.g. "libs/foundry/records/crafting/"), sorted. */
  list(prefix: string): string[] {
    const dir = join(this.root, prefix);
    if (!existsSync(dir)) return [];
    return readdirSync(dir, { recursive: true, encoding: 'utf8' })
      .filter((f) => f.endsWith('.json'))
      .map((f) => (prefix + f.split('\\').join('/')).toLowerCase())
      .sort();
  }
}
