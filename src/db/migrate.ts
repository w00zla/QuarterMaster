// Applies pending migrations from ./drizzle.
import { fileURLToPath } from 'node:url';
import { connectUrl } from './connect-url.ts';

const { migrate, close } = connectUrl(process.env.DATABASE_URL);
try {
  await migrate(fileURLToPath(new URL('../../drizzle', import.meta.url)));
  console.log('Migrations applied');
} finally {
  await close();
}
