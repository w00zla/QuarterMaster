// Installs a data pack into a singleuser data folder (docs/singleuser.md "The data pack"). Order: validate everything
// (touching nothing), import the catalog, write the missing pictures, replace thumbs.json, delete the pictures it no
// longer names, write data-pack.json (last), maintain(). Every step is idempotent: an interrupted install is repeated.
// The file work happens outside the database transaction (runImport's own); no network here.
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runImport, type ImportOptions } from '../catalog/import/apply.ts';
import { loadSnapshot } from '../catalog/import/load.ts';
import { SNAPSHOT_SCHEMA_VERSION } from '../catalog/snapshot.ts';
import type { Connection } from '../db/connect-url.ts';
import { THUMB_FILE } from '../thumbs.ts';
import { openZip, type OpenedZip } from '../zip.ts';
import { sha256Hex } from './build.ts';
import { CATALOG_NAME, DataPackError, MANIFEST_NAME, manifestSchema, parseManifest, type Manifest, type ManifestFile } from './manifest.ts';
import { SIZES, THUMBS_JSON, checkThumbsZip, pictureNames, readEntry, readThumbsZip, type ThumbIndex, type ThumbsZip } from './thumbs.ts';

export const INSTALLED_FILE = 'data-pack.json';

export type PackSource =
  /** A full pack file. */
  | { kind: 'full'; file: string }
  /** The parts of a release: its manifest (parsed JSON), the catalog file and the thumbs updates, oldest first. */
  | { kind: 'parts'; manifest: unknown; catalog: string; thumbsUpdates: string[] };

export interface InstallOptions {
  /** The database: `db` and `maintain` of a connection (never used inside a transaction of the caller). */
  connection: Pick<Connection, 'db' | 'maintain'>;
  /** Where `data-pack.json` goes. */
  dataDir: string;
  /** Where the pictures and thumbs.json go (`<dataDir>/thumbs`). */
  thumbsDir: string;
  source: PackSource;
}

export type InstallResult =
  | {
    status: 'installed';
    tag: string;
    gameLabel: string;
    /** 'unchanged': the catalog was in the database already. */
    catalog: 'imported' | 'unchanged';
    /** Picture files: all that the pack names, written now, removed now. */
    thumbs: { total: number; written: number; removed: number };
  }
  // The pack's catalog schema is not the app's: nothing was touched; the caller says "update the app" (or the pack)
  | { status: 'appTooOld'; tag: string; packSchemaVersion: number; appSchemaVersion: number };

// The guards do not apply to data packs (curated): everything allowed, the ratios cannot be exceeded
const NO_GUARDS: ImportOptions = { dryRun: false, force: false, allowDowngrade: true, maxRetireRatio: 1, maxChangeRatio: 1 };

const matches = (bytes: Uint8Array, file: ManifestFile) => bytes.length === file.size && sha256Hex(bytes) === file.sha256;

/** The manifest of the installed pack, or null if there is none or it cannot be read. */
export function installedPack(dataDir: string): Manifest | null {
  try {
    const parsed = manifestSchema.safeParse(JSON.parse(readFileSync(join(dataDir, INSTALLED_FILE), 'utf8')));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** Writes through a temp file and a rename: a reader sees the old or the new content, never half of one. */
function writeAtomic(path: string, data: Uint8Array) {
  const temp = `${path}.tmp`;
  writeFileSync(temp, data);
  renameSync(temp, path);
}

interface Checked {
  manifest: Manifest;
  catalog: Buffer;
  /** The archives holding pictures; the last one's thumbs.json is the complete one. */
  zips: ThumbsZip[];
}

/** Opens and checks the source without touching the installation. Closes what it opened when it refuses. */
function check(source: PackSource): Checked | { appTooOld: Manifest } {
  const opened: OpenedZip[] = [];
  try {
    if (source.kind === 'full') {
      let archive: OpenedZip;
      try {
        archive = openZip(source.file);
      } catch (err) {
        throw new DataPackError('invalid', `${source.file} is not a usable data pack: ${err instanceof Error ? err.message : String(err)}`);
      }
      opened.push(archive);
      if (!archive.has(MANIFEST_NAME)) throw new DataPackError('invalid', `${source.file} is not a data pack (no ${MANIFEST_NAME})`);
      let json: unknown;
      try {
        json = JSON.parse(readEntry(archive, source.file, MANIFEST_NAME).toString('utf8'));
      } catch (err) {
        throw err instanceof DataPackError ? err : new DataPackError('invalid', `${source.file}: the manifest is not JSON`);
      }
      const manifest = parseManifest(json);
      if (manifest.schemaVersion !== SNAPSHOT_SCHEMA_VERSION) {
        archive.close();
        return { appTooOld: manifest };
      }
      const thumbs = checkThumbsZip(archive, source.file, { extra: [MANIFEST_NAME, CATALOG_NAME], complete: true });
      if (!archive.has(CATALOG_NAME)) throw new DataPackError('invalid', `${source.file} has no ${CATALOG_NAME}`);
      const catalog = readEntry(archive, source.file, CATALOG_NAME);
      if (!matches(catalog, manifest.files.catalog)) throw new DataPackError('checksum', `${source.file}: the catalog does not match the manifest`);
      return { manifest, catalog, zips: [thumbs] };
    }

    const manifest = parseManifest(source.manifest);
    if (manifest.schemaVersion !== SNAPSHOT_SCHEMA_VERSION) return { appTooOld: manifest };
    const catalog = readFileSync(source.catalog);
    if (!matches(catalog, manifest.files.catalog)) throw new DataPackError('checksum', `${source.catalog} does not match the manifest`);
    if (source.thumbsUpdates.length === 0) throw new DataPackError('invalid', 'No thumbnail update was given');
    const zips: ThumbsZip[] = [];
    for (const file of source.thumbsUpdates) {
      const t = readThumbsZip(file);
      opened.push(t.zip);
      zips.push(t);
    }
    // The manifest describes the newest update; the older ones are checked by the caller against their own manifests
    const last = source.thumbsUpdates[source.thumbsUpdates.length - 1]!;
    if (!matches(readFileSync(last), manifest.files.thumbs)) throw new DataPackError('checksum', `${last} does not match the manifest`);
    if (zips[zips.length - 1]!.pictures.length !== manifest.files.thumbs.count) {
      throw new DataPackError('invalid', `${last} holds ${zips[zips.length - 1]!.pictures.length} pictures, the manifest says ${manifest.files.thumbs.count}`);
    }
    return { manifest, catalog, zips };
  } catch (err) {
    for (const z of opened) z.close();
    throw err;
  }
}

/** The pictures the complete thumbs.json names that neither the folder nor the archives have. */
function missingPictures(thumbsDir: string, index: ThumbIndex, zips: ThumbsZip[]): string[] {
  return pictureNames(index).filter((name) => !existsSync(join(thumbsDir, name)) && !zips.some((z) => z.zip.has(name)));
}

/** Lets the event loop run (the sync file work of tens of thousands of pictures would block the server's answers for seconds). */
const breathe = () => new Promise<void>((resolve) => setImmediate(resolve));
const BREATHE_EVERY = 200;

/** Pictures into the folder, thumbs.json replaced, unreferenced pictures deleted. Counts in picture files. */
async function installThumbs(thumbsDir: string, index: ThumbIndex, bytes: Uint8Array, zips: ThumbsZip[]) {
  for (const size of SIZES) mkdirSync(join(thumbsDir, size), { recursive: true });
  const wanted = new Set(pictureNames(index));
  let written = 0;
  let handled = 0;
  for (const name of [...wanted].sort()) {
    if (++handled % BREATHE_EVERY === 0) await breathe();
    const path = join(thumbsDir, name);
    // Same name = same content (the name carries the hash): an existing file stays
    if (existsSync(path)) continue;
    const from = zips.find((z) => z.zip.has(name))!;
    writeAtomic(path, readEntry(from.zip, name, name));
    written++;
  }
  writeAtomic(join(thumbsDir, THUMBS_JSON), bytes);
  let removed = 0;
  for (const size of SIZES) {
    const dir = join(thumbsDir, size);
    for (const file of readdirSync(dir)) {
      if (++handled % BREATHE_EVERY === 0) await breathe();
      const stale = THUMB_FILE.test(file) && !wanted.has(`${size}/${file}`);
      // A temp file of an interrupted write
      if (stale || file.endsWith('.tmp')) {
        unlinkSync(join(dir, file));
        if (stale) removed++;
      }
    }
  }
  return { total: wanted.size, written, removed };
}

export async function installPack(options: InstallOptions): Promise<InstallResult> {
  const { connection, dataDir, thumbsDir, source } = options;

  // --- validate, touching nothing ---
  const checked = check(source);
  if ('appTooOld' in checked) {
    const m = checked.appTooOld;
    return { status: 'appTooOld', tag: m.tag, packSchemaVersion: m.schemaVersion, appSchemaVersion: SNAPSHOT_SCHEMA_VERSION };
  }
  const { manifest, catalog, zips } = checked;
  try {
    const loaded = (() => {
      try {
        return loadSnapshot(catalog);
      } catch (err) {
        throw new DataPackError('invalid', `The catalog of ${manifest.tag} is unusable: ${err instanceof Error ? err.message : String(err)}`);
      }
    })();
    if (loaded.snapshot.game.label !== manifest.game.label || loaded.snapshot.game.build !== manifest.game.build) {
      throw new DataPackError('invalid', `The catalog of ${manifest.tag} is for another game version than its manifest says`);
    }
    const last = zips[zips.length - 1]!;
    const missing = missingPictures(thumbsDir, last.index, zips);
    if (missing.length) {
      throw new DataPackError('incomplete', `${missing.length} pictures of ${manifest.tag} are in no given file nor installed yet, e.g. ${missing[0]}: an earlier thumbnail update is missing`);
    }

    // --- the catalog ---
    const imported = await runImport(connection.db, loaded.snapshot, loaded.sha256, NO_GUARDS);
    if (imported.status !== 'imported' && imported.status !== 'noop') throw new Error(`The catalog import ended as ${imported.status}`);

    // --- the pictures, then the manifest last ---
    const thumbs = await installThumbs(thumbsDir, last.index, last.bytes, zips);
    mkdirSync(dataDir, { recursive: true });
    writeAtomic(join(dataDir, INSTALLED_FILE), Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8'));
    await connection.maintain();
    return {
      status: 'installed', tag: manifest.tag, gameLabel: manifest.game.label,
      catalog: imported.status === 'imported' ? 'imported' : 'unchanged', thumbs,
    };
  } finally {
    for (const z of zips) z.zip.close();
  }
}

