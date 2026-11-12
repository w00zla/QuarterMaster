// `pnpm singleuser:import <file> [options]`: puts catalog data into the singleuser data folder. A full data pack
// (`.zip`, detected by extension or by its content) is installed with installPack (catalog, thumbnails into
// `<data folder>/thumbs`, data-pack.json); a snapshot (`.json`, `.json.gz`) goes through the catalog import CLI (its
// guards and options; for development). Makes sure the schema is there first (a fresh data folder has none).
// The server must not run: one process per data folder.
import { closeSync, mkdirSync, openSync, readSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { connectPglite } from '../db/pglite.ts';
import { installPack } from '../datapack/install.ts';
import { dataDir, dbDir } from './paths.ts';

const data = dataDir(process.env, process.platform, homedir());
mkdirSync(data, { recursive: true });
const db = dbDir(data);
console.log(`data folder: ${data}`);

const file = process.argv.slice(2).find((a) => !a.startsWith('-'));

/** A ZIP starts with "PK\x03\x04" (a snapshot is JSON or gzip). */
function isZip(path: string): boolean {
  if (/\.zip$/i.test(path)) return true;
  const fd = openSync(path, 'r');
  try {
    const head = Buffer.alloc(4);
    readSync(fd, head, 0, 4, 0);
    return head.readUInt32LE(0) === 0x04034b50;
  } finally {
    closeSync(fd);
  }
}

const migrations = fileURLToPath(new URL('../../drizzle', import.meta.url));

if (file && isZip(file)) {
  const connection = connectPglite(db);
  try {
    await connection.migrate(migrations);
    if (process.env.QM_THUMBS_DIR) {
      console.log(`note: the pictures go into ${join(data, 'thumbs')}, but QM_THUMBS_DIR makes the server serve ${process.env.QM_THUMBS_DIR}`);
    }
    const started = performance.now();
    const r = await installPack({ connection, dataDir: data, thumbsDir: join(data, 'thumbs'), source: { kind: 'full', file } });
    if (r.status === 'appTooOld') {
      console.error(`This data pack (${r.tag}) needs a newer app: its catalog format is ${r.packSchemaVersion}, this app reads ${r.appSchemaVersion}. Nothing was changed.`);
      process.exitCode = 2;
    } else {
      console.log(`Installed ${r.tag} (game ${r.gameLabel}): catalog ${r.catalog}, pictures ${r.thumbs.total} (${r.thumbs.written} written, ${r.thumbs.removed} removed), ${((performance.now() - started) / 1000).toFixed(1)} s`);
    }
  } catch (err) {
    console.error(`Install failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  } finally {
    await connection.close();
  }
} else {
  const { migrate, close } = connectPglite(db);
  try {
    await migrate(migrations);
  } finally {
    await close();
  }

  // The CLI reads DATABASE_URL and its arguments from the process, as when started by itself
  process.env.DATABASE_URL = `pglite:${db}`;
  await import('../catalog/import/cli.ts');
}
