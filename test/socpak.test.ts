import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { crc32, deflateRawSync } from 'node:zlib';
import { containerKey, readZip, scanContainers } from '../src/catalog/extract/socpak.ts';

/** A ZIP archive with the given files (first stored, the rest deflated). */
function zip(files: Record<string, string>): Buffer {
  const local: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  Object.entries(files).forEach(([name, text], i) => {
    const data = Buffer.from(text, 'latin1');
    const method = i === 0 ? 0 : 8;
    const body = method === 0 ? data : deflateRawSync(data);
    const n = Buffer.from(name);
    const head = Buffer.alloc(30);
    head.writeUInt32LE(0x04034b50, 0);
    head.writeUInt16LE(method, 8);
    head.writeUInt32LE(crc32(data), 14);
    head.writeUInt32LE(body.length, 18);
    head.writeUInt32LE(data.length, 22);
    head.writeUInt16LE(n.length, 26);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(method, 10);
    entry.writeUInt32LE(crc32(data), 16);
    entry.writeUInt32LE(body.length, 20);
    entry.writeUInt32LE(data.length, 24);
    entry.writeUInt16LE(n.length, 28);
    entry.writeUInt32LE(offset, 42);
    local.push(head, n, body);
    central.push(entry, n);
    offset += head.length + n.length + body.length;
  });
  const dir = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(dir.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, dir, end]);
}

const PROVIDER = '10000000-0000-0000-0000-0000000000a1';
const OTHER = '10000000-0000-0000-0000-0000000000a2';
const MOON = '20000000-0000-0000-0000-0000000000b1';
const CLUSTER_A = '20000000-0000-0000-0000-0000000000b2';
const CLUSTER_B = '20000000-0000-0000-0000-0000000000b3';

const child = (name: string, starMap?: string) =>
  `<Child external="1" name="${name}" entityName="x" class="LocationObjectContainer"${starMap ? ` starMapRecord="${starMap}"` : ''}>\n</Child>`;
const container = (name: string, children: string[]) =>
  `<ObjectContainer version="12" name="${name}"><ChildObjectContainers>${children.join('')}</ChildObjectContainers></ObjectContainer>`;
// A .soc holds CryXmlB strings among binary data
const soc = (guid: string) => `CrChF\u0000\u0001HarvestableProviderParams\u0000${guid.toUpperCase()}\u0000ÿ`;

describe('socpak', () => {
  it('reads stored and deflated entries', () => {
    const entries = readZip(zip({ 'a.xml': '<x/>', 'b/c.soc': 'binary\u0000data' }));
    assert.deepEqual(entries.map((e) => [e.name, e.data().toString('latin1')]), [['a.xml', '<x/>'], ['b/c.soc', 'binary\u0000data']]);
  });

  it('normalizes container paths', () => {
    assert.equal(containerKey('Data\\ObjectContainers\\PU\\System\\X.socpak'), 'objectcontainers/pu/system/x.socpak');
    assert.equal(containerKey('Data/objectcontainers/pu/x.socpak'), 'objectcontainers/pu/x.socpak');
  });

  it('links providers to the star map records of their containers', () => {
    const sys = 'Data/ObjectContainers/PU/system/test';
    const scan = scanContainers([
      // The system lists the moon (with its record), a field container without one, and a base placed twice
      { path: `${sys}/system.socpak`, buf: zip({ 'system.xml': container('system', [
        child('Data/ObjectContainers/PU/system/test/moon.socpak', MOON),
        child('Data/ObjectContainers/PU/system/test/field.socpak'),
        child('Data/ObjectContainers/PU/system/test/base.socpak', CLUSTER_A),
        child('Data/ObjectContainers/PU/system/test/base.socpak', CLUSTER_B),
      ]), 'system_editor.xml': container('system', [child('Data/ObjectContainers/PU/system/test/editor.socpak', OTHER)]) }) },
      // The moon uses the provider in its own .soc; its child cloud (no record of its own) uses another
      { path: `${sys}/moon.socpak`, buf: zip({ 'moon.xml': container('moon', [child('Data/ObjectContainers/PU/system/test/cloud.socpak')]), 'moon.soc': soc(PROVIDER) }) },
      { path: `${sys}/cloud.socpak`, buf: zip({ 'cloud.xml': container('cloud', []), 'entdata/1.entxml': soc(OTHER) }) },
      { path: `${sys}/base.socpak`, buf: zip({ 'base.xml': container('base', []), 'base.soc': soc(OTHER) }) },
      // No record anywhere above it: not placed
      { path: `${sys}/field.socpak`, buf: zip({ 'field.xml': container('field', []), 'field.soc': soc(PROVIDER) }) },
    ], new Set([PROVIDER, OTHER]));
    assert.deepEqual(Object.fromEntries([...scan.places].map(([k, v]) => [k, [...v].sort()])), {
      [PROVIDER]: [MOON],
      [OTHER]: [CLUSTER_A, CLUSTER_B, MOON].sort(),
    });
    assert.deepEqual(scan.unplaced, [{ container: 'objectcontainers/pu/system/test/field.socpak', providers: [PROVIDER] }]);
  });
});
