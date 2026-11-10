// ZIP archives without compression: a writer (the feature exports, the data pack) and a reader over a file.
// Limits, both ways: no ZIP64, so at most 65535 entries, every entry and the whole archive below 4 GiB. The writer
// and the reader fail clearly beyond them. Format: APPNOTE.TXT, local headers, central directory, end record;
// names in UTF-8 (flag bit 11).
import { closeSync, fstatSync, openSync, readSync } from 'node:fs';
import { crc32 } from 'node:zlib';

export interface ZipFile {
  name: string;
  data: Buffer;
}

const MAX_ENTRIES = 0xfffe;
const MAX_SIZE = 0xfffffffe;

/** A fixed entry date (1980-01-01 00:00, the MS-DOS epoch): archives built from the same files are byte-identical. */
export const ZIP_EPOCH = new Date(1980, 0, 1, 0, 0, 0);

export function zip(files: ZipFile[], date = new Date()): Buffer {
  if (files.length > MAX_ENTRIES) throw new Error(`ZIP: ${files.length} entries (at most ${MAX_ENTRIES}: no ZIP64)`);
  // MS-DOS time and date of the entries
  const time = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
  const day = ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const f of files) {
    const name = Buffer.from(f.name, 'utf8');
    if (f.data.length > MAX_SIZE) throw new Error(`ZIP: ${f.name} is larger than 4 GiB (no ZIP64)`);
    const crc = crc32(f.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(day, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(f.data.length, 18);
    local.writeUInt32LE(f.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(day, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(f.data.length, 20);
    central.writeUInt32LE(f.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, name, f.data);
    centrals.push(central, name);
    offset += local.length + name.length + f.data.length;
    if (offset > MAX_SIZE) throw new Error('ZIP: the archive is larger than 4 GiB (no ZIP64)');
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

/** An entry name that stays inside the folder it is extracted to: relative, `/` separators, no `..`, no drive. */
export function isSafeZipName(name: string): boolean {
  if (name === '' || name.startsWith('/') || name.includes('\\') || name.includes('\0') || /^[a-zA-Z]:/.test(name)) return false;
  return name.split('/').every((part) => part !== '' && part !== '.' && part !== '..');
}

export interface ZipEntryInfo {
  name: string;
  size: number;
}

export interface OpenedZip {
  /** The entries in archive order. */
  entries: readonly ZipEntryInfo[];
  has(name: string): boolean;
  /** One entry's content, read from the file on demand and checked against its CRC-32. */
  read(name: string): Buffer;
  close(): void;
}

/**
 * Opens an uncompressed ZIP file: reads the end record and the central directory only; entries are read one at a time
 * with `read()`. Throws on a compressed or encrypted entry, ZIP64, a duplicate name or an unsafe name (`isSafeZipName`).
 */
export function openZip(path: string): OpenedZip {
  const fd = openSync(path, 'r');
  try {
    const total = fstatSync(fd).size;
    const readAt = (position: number, length: number): Buffer => {
      const buf = Buffer.alloc(length);
      if (length > 0 && readSync(fd, buf, 0, length, position) !== length) throw new Error('ZIP: the file ends early');
      return buf;
    };
    // The end record sits in the last 22 bytes plus a comment of at most 65535
    const tailLength = Math.min(total, 22 + 0xffff);
    const tail = readAt(total - tailLength, tailLength);
    let end = tail.length - 22;
    while (end >= 0 && tail.readUInt32LE(end) !== 0x06054b50) end--;
    if (end < 0) throw new Error('ZIP: no end of central directory (not a ZIP file)');
    const count = tail.readUInt16LE(end + 10);
    const directorySize = tail.readUInt32LE(end + 12);
    const directoryAt = tail.readUInt32LE(end + 16);
    if (count === 0xffff || directorySize === 0xffffffff || directoryAt === 0xffffffff) throw new Error('ZIP: ZIP64 is not supported');
    if (directoryAt + directorySize > total) throw new Error('ZIP: broken central directory');
    const directory = readAt(directoryAt, directorySize);

    const table = new Map<string, { size: number; crc: number; local: number }>();
    const entries: ZipEntryInfo[] = [];
    let p = 0;
    for (let i = 0; i < count; i++) {
      if (p + 46 > directory.length || directory.readUInt32LE(p) !== 0x02014b50) throw new Error('ZIP: broken central directory');
      const flags = directory.readUInt16LE(p + 8);
      const method = directory.readUInt16LE(p + 10);
      const crc = directory.readUInt32LE(p + 16);
      const compressed = directory.readUInt32LE(p + 20);
      const size = directory.readUInt32LE(p + 24);
      const nameLength = directory.readUInt16LE(p + 28);
      const local = directory.readUInt32LE(p + 42);
      const name = directory.toString('utf8', p + 46, p + 46 + nameLength);
      p += 46 + nameLength + directory.readUInt16LE(p + 30) + directory.readUInt16LE(p + 32);
      if (!isSafeZipName(name)) throw new Error(`ZIP: unsafe entry name ${JSON.stringify(name)}`);
      if (table.has(name)) throw new Error(`ZIP: duplicate entry ${name}`);
      if (method !== 0 || compressed !== size) throw new Error(`ZIP: ${name} is compressed (only stored entries are supported)`);
      if (flags & 1) throw new Error(`ZIP: ${name} is encrypted`);
      table.set(name, { size, crc, local });
      entries.push({ name, size });
    }
    return {
      entries,
      has: (name) => table.has(name),
      read(name) {
        const entry = table.get(name);
        if (!entry) throw new Error(`ZIP: no entry ${name}`);
        const header = readAt(entry.local, 30);
        if (header.readUInt32LE(0) !== 0x04034b50) throw new Error(`ZIP: broken local header of ${name}`);
        const start = entry.local + 30 + header.readUInt16LE(26) + header.readUInt16LE(28);
        if (start + entry.size > total) throw new Error(`ZIP: ${name} ends beyond the file`);
        const data = readAt(start, entry.size);
        if (crc32(data) !== entry.crc) throw new Error(`ZIP: ${name} is damaged (CRC mismatch)`);
        return data;
      },
      close: () => closeSync(fd),
    };
  } catch (err) {
    closeSync(fd);
    throw err;
  }
}
