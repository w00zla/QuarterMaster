// Builds a data release (docs/singleuser.md "The data pack"): four assets in an output folder, from a snapshot, the
// thumbnails folder and, if there is one, the predecessor release's assets. The output depends on the input only:
// entries are sorted by code point, the ZIP entries carry a fixed date (ZIP_EPOCH), every JSON is serialized from a
// fixed key order, and the gzip header is pinned (see `gzipStable`), so the same input gives the same bytes and hashes
// (with the same Node/zlib version: the deflate output is zlib's).
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { loadSnapshot } from '../catalog/import/load.ts';
import { SNAPSHOT_SCHEMA_VERSION } from '../catalog/snapshot.ts';
import { ZIP_EPOCH, zip, type ZipFile } from '../zip.ts';
import {
  CATALOG_NAME, DATA_PACK_FORMAT, DataPackError, EMBEDDED_FULL, MANIFEST_NAME, THUMBS_UPDATE_NAME, fullPackName, isGameLabel, parseManifest, tagOf,
  type Manifest, type ManifestFile,
} from './manifest.ts';
import { THUMBS_JSON, parseThumbIndex, pictureNames, readThumbsZip, serializeThumbIndex, type ThumbIndex } from './thumbs.ts';

export const sha256Hex = (data: Uint8Array): string => createHash('sha256').update(data).digest('hex');

/** gzip, level 9, with the header's OS byte pinned to 3 (Unix): zlib writes the platform's code there otherwise. */
export function gzipStable(data: Uint8Array): Buffer {
  const out = gzipSync(data, { level: 9 });
  out[9] = 3;
  return out;
}

export interface BuildReleaseOptions {
  /** A v7 snapshot (`.json` or `.json.gz`), full or slim. */
  snapshotFile: string;
  /** Holds thumbs.json, s/, m/, l/. */
  thumbsDir: string;
  /** Counts re-issues for the same game version: 1, 2, … */
  n: number;
  /** A folder with the predecessor's manifest.json and thumbs-update.zip; none for a first release. */
  previousDir?: string;
  outDir: string;
}

export interface BuiltAsset {
  name: string;
  size: number;
  sha256: string;
}

export interface BuildReleaseResult {
  tag: string;
  manifest: Manifest;
  outDir: string;
  /** manifest.json, the full pack, catalog.json.gz, thumbs-update.zip. */
  assets: BuiltAsset[];
  thumbs: {
    /** Pictures (files) in the release in all. */
    total: number;
    /** Pictures in thumbs-update.zip: the ones whose file name is not in the predecessor's set. */
    added: number;
  };
}

const describe = (name: string, data: Uint8Array): ManifestFile => ({ name, size: data.length, sha256: sha256Hex(data) });

/** The predecessor's manifest and complete thumbs.json, read from its assets (the thumbs update is checked against the manifest). */
export function readPredecessor(dir: string): { manifest: Manifest; index: ThumbIndex } {
  const manifestFile = join(dir, MANIFEST_NAME);
  const updateFile = join(dir, THUMBS_UPDATE_NAME);
  for (const f of [manifestFile, updateFile]) if (!existsSync(f)) throw new DataPackError('invalid', `Predecessor: ${f} is missing`);
  let json: unknown;
  try {
    json = JSON.parse(readFileSync(manifestFile, 'utf8'));
  } catch {
    throw new DataPackError('invalid', `Predecessor: ${manifestFile} is not JSON`);
  }
  const manifest = parseManifest(json);
  const bytes = readFileSync(updateFile);
  if (bytes.length !== manifest.files.thumbs.size || sha256Hex(bytes) !== manifest.files.thumbs.sha256) {
    throw new DataPackError('checksum', `Predecessor: ${updateFile} does not match its manifest`);
  }
  const t = readThumbsZip(updateFile);
  t.zip.close();
  return { manifest, index: t.index };
}

export function buildRelease(options: BuildReleaseOptions): BuildReleaseResult {
  const { snapshotFile, thumbsDir, n, previousDir, outDir } = options;
  if (!Number.isInteger(n) || n < 1) throw new Error('n must be a whole number from 1');

  // --- the catalog: the snapshot without its raw records ---
  const loaded = loadSnapshot(readFileSync(snapshotFile));
  const { rawRecords: _dropped, ...slim } = loaded.snapshot;
  const label = loaded.snapshot.game.label!;
  if (!isGameLabel(label)) throw new Error(`The game label ${JSON.stringify(label)} cannot be used in file names`);
  const catalog = gzipStable(Buffer.from(JSON.stringify(slim), 'utf8'));
  const tag = tagOf(label, n);

  // --- the thumbnails ---
  const thumbsJson = join(thumbsDir, THUMBS_JSON);
  if (!existsSync(thumbsJson)) throw new Error(`${thumbsJson} is missing`);
  const index = parseThumbIndex(readFileSync(thumbsJson));
  const names = pictureNames(index);
  const missing = names.filter((name) => !existsSync(join(thumbsDir, name)));
  if (missing.length) {
    throw new Error(`${missing.length} pictures named by thumbs.json are missing in ${thumbsDir}: ${missing.slice(0, 5).join(', ')}${missing.length > 5 ? ', …' : ''}`);
  }
  const previous = previousDir ? readPredecessor(previousDir) : null;
  if (previous && previous.manifest.tag === tag) throw new Error(`The predecessor is ${tag} itself: use a higher n`);
  const known = new Set(previous ? pictureNames(previous.index) : []);
  const fresh = names.filter((name) => !known.has(name));
  const thumbsBytes = serializeThumbIndex(index);
  const picture = (name: string): ZipFile => ({ name, data: readFileSync(join(thumbsDir, name)) });

  const thumbsUpdate = zip([{ name: THUMBS_JSON, data: thumbsBytes }, ...fresh.map(picture)], ZIP_EPOCH);

  // --- the manifest, and the full pack with its copy of it (files.full there: EMBEDDED_FULL) ---
  const manifest: Manifest = {
    format: DATA_PACK_FORMAT,
    tag,
    previous: previous ? previous.manifest.tag : null,
    game: { label, build: loaded.snapshot.game.build },
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    files: {
      full: { name: fullPackName(label, n), ...EMBEDDED_FULL },
      catalog: describe(CATALOG_NAME, catalog),
      thumbs: { ...describe(THUMBS_UPDATE_NAME, thumbsUpdate), count: fresh.length },
    },
  };
  const json = (m: Manifest) => Buffer.from(`${JSON.stringify(m, null, 2)}\n`, 'utf8');
  const fullPack = zip([
    { name: MANIFEST_NAME, data: json(manifest) },
    { name: CATALOG_NAME, data: catalog },
    { name: THUMBS_JSON, data: thumbsBytes },
    ...names.map(picture),
  ], ZIP_EPOCH);
  manifest.files.full = describe(manifest.files.full.name, fullPack);
  const standalone = json(manifest);

  mkdirSync(outDir, { recursive: true });
  const outputs: [string, Buffer][] = [
    [MANIFEST_NAME, standalone], [manifest.files.full.name, fullPack], [CATALOG_NAME, catalog], [THUMBS_UPDATE_NAME, thumbsUpdate],
  ];
  for (const [name, data] of outputs) writeFileSync(join(outDir, name), data);
  return {
    tag, manifest, outDir,
    assets: outputs.map(([name, data]) => ({ name, size: data.length, sha256: sha256Hex(data) })),
    thumbs: { total: names.length, added: fresh.length },
  };
}
