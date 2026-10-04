// Applies pending migrations from ./drizzle.
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { connect } from './client.ts';

const { db, close } = connect(process.env.DATABASE_URL);
try {
  await migrate(db, { migrationsFolder: new URL('../../drizzle', import.meta.url).pathname });
  console.log('Migrations applied');
} finally {
  await close();
}
