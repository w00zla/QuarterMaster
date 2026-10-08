// Applies pending migrations from ./drizzle.
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { connect } from './client.ts';

const { db, close } = connect(process.env.DATABASE_URL);
try {
  await migrate(db, { migrationsFolder: fileURLToPath(new URL('../../drizzle', import.meta.url)) });
  console.log('Migrations applied');
} finally {
  await close();
}
