// DB test setup. With TEST_ROLES=1 (scripts/test-roles.sh) the tests run like production: the schema is
// migrated as qm_owner, deploy/db-roles.sh grants the rights, and the code under test connects as
// qm_app (bot, admin, ext) or qm_web (user web app) instead of the superuser. Without it everything runs as before.
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { connect, schema, type Db } from '../src/db/client.ts';

export type Role = 'qm_app' | 'qm_web';
export const ROLES = process.env.TEST_ROLES === '1';

const rootDir = fileURLToPath(new URL('..', import.meta.url));
const migrationsFolder = fileURLToPath(new URL('../drizzle', import.meta.url));
const SCHEMAS = ['ext', 'web', 'bot', 'app', 'catalog', 'drizzle'];

/** The production script; psql comes from the PATH (scripts/test-roles.sh puts a wrapper there). */
function applyRoles(url: string) {
  const dbName = new URL(url).pathname.slice(1);
  execFileSync('bash', [`${rootDir}deploy/db-roles.sh`], {
    stdio: ['ignore', 'ignore', 'inherit'],
    env: {
      ...process.env, POSTGRES_DB: dbName, POSTGRES_USER: decodeURIComponent(new URL(url).username),
      QM_OWNER_PASSWORD: 'test', QM_APP_PASSWORD: 'test', QM_WEB_PASSWORD: 'test',
    },
  });
}

/** Drops all schemas and migrates; under TEST_ROLES as qm_owner, with the grants applied before and after. */
export async function prepareDb(url: string | undefined): Promise<void> {
  const { db, close } = connect(url);
  try {
    for (const s of SCHEMAS) await db.execute(sql.raw(`DROP SCHEMA IF EXISTS ${s} CASCADE`));
    if (!ROLES) return await migrate(db, { migrationsFolder });
    applyRoles(url!);
  } finally {
    await close();
  }
  const owner = connectAs(url, 'qm_owner');
  try {
    await migrate(owner.db, { migrationsFolder });
  } finally {
    await owner.close();
  }
  applyRoles(url!);
}

/** Like connect(), but every session of the connection runs as the role (SET ROLE at startup) under TEST_ROLES. */
export function connectAs(url: string | undefined, role: Role | 'qm_owner') {
  if (!ROLES) return connect(url);
  if (!url) throw new Error('TEST_DATABASE_URL is not set');
  const client = postgres(url, { onnotice: () => {}, connection: { jit: 'off', role } });
  return { db: drizzle(client, { schema }) as Db, close: () => client.end(), client };
}
