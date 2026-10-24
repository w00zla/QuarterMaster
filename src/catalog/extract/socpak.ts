// Object containers (socpaks, ZIP archives in Data.p4k): which star map object a container sits at and which
// harvestable providers its entities use. A container's XML lists its children with their star map record;
// the provider is referenced by its record GUID inside the binary .soc (CryXmlB strings, read as text).
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

export interface ContainerScan {
  // Provider record uuid -> star map object uuids of the containers using it
  places: Map<string, Set<string>>;
  // Containers using a provider without any star map record above them (not placed in the game), with those providers
  unplaced: { container: string; providers: string[] }[];
}

/**
 * Reads socpaks and links each harvestable provider used inside a container to the star map records of that
 * container: the record its parent lists it with, else the nearest ancestor's. A container placed at several
 * objects (one asteroid base layout in many clusters) links to all of them.
 */
export function scanContainers(files: { path: string; buf: Buffer }[], providerUuids: Set<string>): ContainerScan {
  const providersIn = new Map<string, Set<string>>();
  const parentOf = new Map<string, string>();
  const starMapOf = new Map<string, Set<string>>();
  for (const f of files) {
    const key = containerKey(f.path);
    const found = new Set<string>();
    for (const e of readZip(f.buf)) {
      const name = e.name.toLowerCase();
      if (name.endsWith('.soc') || name.endsWith('.entxml')) {
        for (const m of e.data().toString('latin1').match(GUID) ?? []) if (providerUuids.has(m.toLowerCase())) found.add(m.toLowerCase());
      } else if (!name.includes('/') && name.endsWith('.xml') && !name.endsWith('_editor.xml')) {
        for (const m of e.data().toString('utf8').matchAll(/<Child\b[^>]*>/g)) {
          const child = /\bname="([^"]+\.socpak)"/i.exec(m[0])?.[1];
          if (!child) continue;
          const childKey = containerKey(child);
          if (!parentOf.has(childKey)) parentOf.set(childKey, key);
          const record = /\bstarMapRecord="([0-9a-f-]{36})"/i.exec(m[0])?.[1];
          if (record) starMapOf.set(childKey, (starMapOf.get(childKey) ?? new Set()).add(record.toLowerCase()));
        }
      }
    }
    if (found.size) providersIn.set(key, found);
  }

  const places = new Map<string, Set<string>>();
  const unplaced: ContainerScan['unplaced'] = [];
  for (const [key, providers] of providersIn) {
    let at: string | undefined = key;
    for (let hops = 0; at && !starMapOf.has(at) && hops < 20; hops++) at = parentOf.get(at);
    const records = at ? starMapOf.get(at) : undefined;
    if (!records) {
      unplaced.push({ container: key, providers: [...providers].sort() });
      continue;
    }
    for (const p of providers) places.set(p, new Set([...(places.get(p) ?? []), ...records]));
  }
  return { places, unplaced: unplaced.sort((a, b) => a.container.localeCompare(b.container)) };
}

/** Reads the socpak files and scans them (see scanContainers). */
export const scanContainerFiles = (paths: string[], providerUuids: Set<string>) =>
  scanContainers(paths.map((path) => ({ path, buf: readFileSync(path) })), providerUuids);
