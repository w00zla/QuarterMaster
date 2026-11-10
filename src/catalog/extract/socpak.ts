// Object containers (socpaks, ZIP archives in Data.p4k): which star map object a container sits at, which
// harvestable providers its entities use and whether it places a refinery. A container's XML lists its children with
// their star map record; providers and the refinery entity are referenced by their record GUID inside the binary .soc
// (CryXmlB strings, read as text).
import { readFileSync } from 'node:fs';
import { inflateRawSync } from 'node:zlib';

interface ZipEntry { name: string; data: () => Buffer }

/** The entries of a ZIP archive (stored or deflated, no ZIP64: socpaks stay far below 4 GB). */
export function readZip(buf: Buffer): ZipEntry[] {
  let end = buf.length - 22;
  while (end >= 0 && buf.readUInt32LE(end) !== 0x06054b50) end--;
  if (end < 0) throw new Error('no end of central directory');
  const count = buf.readUInt16LE(end + 10);
  let p = buf.readUInt32LE(end + 16);
  const entries: ZipEntry[] = [];
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('broken central directory');
    const method = buf.readUInt16LE(p + 10);
    const size = buf.readUInt32LE(p + 20);
    const nameLength = buf.readUInt16LE(p + 28);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLength);
    p += 46 + nameLength + buf.readUInt16LE(p + 30) + buf.readUInt16LE(p + 32);
    entries.push({
      name,
      data: () => {
        const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
        const raw = buf.subarray(start, start + size);
        if (method === 0) return raw;
        if (method === 8) return inflateRawSync(raw);
        throw new Error(`${name}: compression method ${method}`);
      },
    });
  }
  return entries;
}

/** "Data/ObjectContainers/PU/system/x.socpak" (any case, either slash) -> "objectcontainers/pu/system/x.socpak" */
export const containerKey = (path: string) => path.replaceAll('\\', '/').toLowerCase().replace(/^.*?(objectcontainers\/)/, '$1');

const GUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

// The mining scan looks only at the star systems' containers (its results are defined by them); the refinery scan at all
const MINING_PREFIX = 'objectcontainers/pu/system/';

export interface ContainerScan {
  // Provider record uuid -> star map object uuids of the containers using it
  places: Map<string, Set<string>>;
  // Containers using a provider without any star map record above them (not placed in the game), with those providers
  unplaced: { container: string; providers: string[] }[];
  // The refinery entity records searched for (DataCore: entities with a refinery component)
  refineryEntities: string[];
  // Star map object uuids that have a refinery: the nearest records above every container placing a refinery entity
  refineryPlaces: Set<string>;
  // Containers placing a refinery without any star map record above them
  refineryUnplaced: string[];
}

/**
 * The container tree as the XMLs list it: child -> every parent (a module is used by many stations) and child -> the
 * star map records it is listed with. Edges carry no positions yet: a star map feature will need each <Child>'s
 * `pos` and `rot`; they go onto the parent edge (Set -> Map keyed by parent), so the tree stays as it is.
 */
class Tree {
  readonly parents = new Map<string, Set<string>>();
  readonly starMap = new Map<string, Set<string>>();

  addChild(parent: string, childTag: string) {
    const child = /\bname="([^"]+\.socpak)"/i.exec(childTag)?.[1];
    if (!child) return;
    const childKey = containerKey(child);
    this.parents.set(childKey, (this.parents.get(childKey) ?? new Set()).add(parent));
    const record = /\bstarMapRecord="([0-9a-f-]{36})"/i.exec(childTag)?.[1];
    if (record) this.starMap.set(childKey, (this.starMap.get(childKey) ?? new Set()).add(record.toLowerCase()));
  }

  /** The records of the container, else of its first parent's first ancestor with one (the mining semantics). */
  firstPlace(key: string): Set<string> | undefined {
    let at: string | undefined = key;
    for (let hops = 0; at && !this.starMap.has(at) && hops < 20; hops++) at = this.parents.get(at)?.values().next().value;
    return at ? this.starMap.get(at) : undefined;
  }

  /** The nearest star map records above a container (itself included), along every parent path. */
  nearestPlaces(key: string): Set<string> {
    const out = new Set<string>();
    const seen = new Set<string>();
    const walk = (k: string, hops: number) => {
      if (seen.has(k) || hops > 25) return;
      seen.add(k);
      const own = this.starMap.get(k);
      if (own) return void own.forEach((r) => out.add(r));
      for (const p of this.parents.get(k) ?? []) walk(p, hops + 1);
    };
    walk(key, 0);
    return out;
  }
}

/**
 * Reads socpaks one at a time (add) and links what they hold to star map records:
 * - each harvestable provider used inside a container to the record its parent lists it with, else the nearest
 *   ancestor's (the first parent; star system containers only). A container placed at several objects (one asteroid
 *   base layout in many clusters) links to all of them.
 * - each refinery entity placed in a container to the nearest records above it along every parent path (all containers).
 */
export class ContainerScanner {
  private readonly providersIn = new Map<string, Set<string>>();
  private readonly refineryIn = new Set<string>();
  private readonly mining = new Tree();
  private readonly all = new Tree();
  private readonly refinery: Set<string>;
  private readonly providerUuids: Set<string>;
  private readonly refineryEntities: string[];

  constructor(providerUuids: Set<string>, refineryEntities: string[] = []) {
    this.providerUuids = providerUuids;
    this.refineryEntities = refineryEntities;
    this.refinery = new Set(refineryEntities.map((u) => u.toLowerCase()));
  }

  add(path: string, buf: Buffer) {
    const key = containerKey(path);
    const isMining = key.startsWith(MINING_PREFIX);
    const found = new Set<string>();
    for (const e of readZip(buf)) {
      const name = e.name.toLowerCase();
      if (name.endsWith('.soc') || name.endsWith('.entxml')) {
        for (const m of e.data().toString('latin1').match(GUID) ?? []) {
          const guid = m.toLowerCase();
          if (isMining && this.providerUuids.has(guid)) found.add(guid);
          if (this.refinery.has(guid)) this.refineryIn.add(key);
        }
      } else if (!name.includes('/') && name.endsWith('.xml') && !name.endsWith('_editor.xml')) {
        for (const m of e.data().toString('utf8').matchAll(/<Child\b[^>]*>/g)) {
          this.all.addChild(key, m[0]);
          if (isMining) this.mining.addChild(key, m[0]);
        }
      }
    }
    if (found.size) this.providersIn.set(key, found);
  }

  finish(): ContainerScan {
    const places = new Map<string, Set<string>>();
    const unplaced: ContainerScan['unplaced'] = [];
    for (const [key, providers] of this.providersIn) {
      const records = this.mining.firstPlace(key);
      if (!records) {
        unplaced.push({ container: key, providers: [...providers].sort() });
        continue;
      }
      for (const p of providers) places.set(p, new Set([...(places.get(p) ?? []), ...records]));
    }
    const refineryPlaces = new Set<string>();
    const refineryUnplaced: string[] = [];
    for (const key of this.refineryIn) {
      const records = this.all.nearestPlaces(key);
      if (!records.size) refineryUnplaced.push(key);
      records.forEach((r) => refineryPlaces.add(r));
    }
    return {
      places, unplaced: unplaced.sort((a, b) => a.container.localeCompare(b.container)),
      refineryEntities: [...this.refineryEntities], refineryPlaces, refineryUnplaced: refineryUnplaced.sort(),
    };
  }
}

/** Scans the given socpaks (see ContainerScanner). */
export function scanContainers(files: { path: string; buf: Buffer }[], providerUuids: Set<string>, refineryEntities: string[] = []): ContainerScan {
  const scanner = new ContainerScanner(providerUuids, refineryEntities);
  for (const f of files) scanner.add(f.path, f.buf);
  return scanner.finish();
}

/** Reads the socpak files one by one (3.5 GB in all: never all in memory) and scans them. */
export function scanContainerFiles(paths: string[], providerUuids: Set<string>, refineryEntities: string[] = []): ContainerScan {
  const scanner = new ContainerScanner(providerUuids, refineryEntities);
  for (const path of paths) scanner.add(path, readFileSync(path));
  return scanner.finish();
}
