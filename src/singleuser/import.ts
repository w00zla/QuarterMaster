// `pnpm singleuser:import <snapshot> [options]`: the catalog import CLI against the singleuser database. Makes sure
// the schema is there first (a fresh data folder has none). The server must not run: one process per data folder.
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { connectPglite } from '../db/pglite.ts';
import { dataDir, dbDir } from './paths.ts';

const data = dataDir(process.env, process.platform, homedir());
mkdirSync(data, { recursive: true });
const db = dbDir(data);
console.log(`data folder: ${data}`);

const { migrate, close } = connectPglite(db);
try {
  await migrate(fileURLToPath(new URL('../../drizzle', import.meta.url)));
} finally {
  await close();
}

// The CLI reads DATABASE_URL and its arguments from the process, as when started by itself
process.env.DATABASE_URL = `pglite:${db}`;
await import('../catalog/import/cli.ts');
