// The thumbnail side of a data pack: `thumbs.json` {uuid: hash} and the picture files it names (src/thumbs.ts).
import { THUMB_FILE, THUMB_HASH, THUMB_SIZES, thumbFile, type ThumbSize } from '../thumbs.ts';
import { openZip, type OpenedZip } from '../zip.ts';
import { DataPackError } from './manifest.ts';

export const THUMBS_JSON = 'thumbs.json';
export const SIZES = Object.keys(THUMB_SIZES) as ThumbSize[];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** uuid -> hash. */
export type ThumbIndex = ReadonlyMap<string, string>;

export const byCodePoint = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** Parses thumbs.json strictly: an object of uuid -> 8 hex digits. */
export function parseThumbIndex(bytes: Uint8Array): ThumbIndex {
  let json: unknown;
  try {
    json = JSON.parse(Buffer.from(bytes).toString('utf8'));
  } catch {
    throw new DataPackError('invalid', 'thumbs.json is not JSON');
  }
  if (typeof json !== 'object' || json === null || Array.isArray(json)) throw new DataPackError('invalid', 'thumbs.json is not an object');
  const index = new Map<string, string>();
  for (const [uuid, hash] of Object.entries(json)) {
    if (!UUID.test(uuid) || typeof hash !== 'string' || !THUMB_HASH.test(hash)) {
      throw new DataPackError('invalid', `thumbs.json: bad entry ${JSON.stringify(uuid)}`);
    }
    index.set(uuid, hash);
  }
  return index;
}

/** The canonical bytes of an index: keys sorted, compact; the same index always gives the same bytes. */
export function serializeThumbIndex(index: ThumbIndex): Buffer {
  const sorted = [...index].sort(([a], [b]) => byCodePoint(a, b));
  return Buffer.from(JSON.stringify(Object.fromEntries(sorted)), 'utf8');
}

/** Every picture the index names, as `<size>/<uuid>.<hash>.avif`, sorted. */
export function pictureNames(index: ThumbIndex): string[] {
  const names: string[] = [];
  for (const [uuid, hash] of index) for (const size of SIZES) names.push(`${size}/${thumbFile(uuid, hash)}`);
  return names.sort(byCodePoint);
}

const PICTURE = new RegExp(`^(${SIZES.join('|')})/(.+)$`);

/** True for `<size>/<uuid>.<hash>.avif` with a known size. */
export function isPictureName(name: string): boolean {
  const m = PICTURE.exec(name);
  return !!m && THUMB_FILE.test(m[2]!);
}

export interface ThumbsZip {
  zip: OpenedZip;
  /** The complete thumbs.json of the archive. */
  bytes: Buffer;
  index: ThumbIndex;
  /** The pictures in the archive (entry names), sorted. */
  pictures: string[];
}

/**
 * Opens a thumbs-update.zip or a full pack and checks its entries: thumbs.json, the pictures and the `extra` names;
 * every picture must be named by thumbs.json. With `complete`, every picture thumbs.json names must be in the archive.
 * Closes the archive again when it refuses.
 */
export function readThumbsZip(path: string, options: { extra?: readonly string[]; complete?: boolean } = {}): ThumbsZip {
  let zip: OpenedZip;
  try {
    zip = openZip(path);
  } catch (err) {
    throw new DataPackError('invalid', `${path} is not a usable data pack file: ${err instanceof Error ? err.message : String(err)}`);
  }
  try {
    return checkThumbsZip(zip, path, options);
  } catch (err) {
    zip.close();
    throw err;
  }
}

/** The entry checks of `readThumbsZip` on an archive that is open already. */
export function checkThumbsZip(zip: OpenedZip, label: string, options: { extra?: readonly string[]; complete?: boolean } = {}): ThumbsZip {
  const extra = new Set(options.extra ?? []);
  const pictures: string[] = [];
  for (const { name } of zip.entries) {
    if (name === THUMBS_JSON || extra.has(name)) continue;
    if (!isPictureName(name)) throw new DataPackError('invalid', `${label}: unexpected entry ${JSON.stringify(name)}`);
    pictures.push(name);
  }
  if (!zip.has(THUMBS_JSON)) throw new DataPackError('invalid', `${label} has no ${THUMBS_JSON}`);
  const bytes = readEntry(zip, label, THUMBS_JSON);
  const index = parseThumbIndex(bytes);
  const wanted = new Set(pictureNames(index));
  for (const name of pictures) {
    if (!wanted.has(name)) throw new DataPackError('invalid', `${label}: ${name} is not named by ${THUMBS_JSON}`);
  }
  if (options.complete) {
    const present = new Set(pictures);
    const missing = [...wanted].filter((n) => !present.has(n));
    if (missing.length) throw new DataPackError('incomplete', `${label}: ${missing.length} pictures are missing, e.g. ${missing[0]}`);
  }
  return { zip, bytes, index, pictures: pictures.sort(byCodePoint) };
}

/** `zip.read` with a refusal that names the archive. */
export function readEntry(zip: OpenedZip, label: string, name: string): Buffer {
  try {
    return zip.read(name);
  } catch (err) {
    throw new DataPackError('invalid', `${label}: ${err instanceof Error ? err.message : String(err)}`);
  }
}
