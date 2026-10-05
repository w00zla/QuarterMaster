// Liveness of the roster sync for the user web app (bot.heartbeat): the web app has no interaction
// with roles and relies on the roster, which is only current while the bot is connected.
import { sql } from 'drizzle-orm';
import type { Db } from '../db/client.ts';
import { heartbeat } from '../db/schema/bot.ts';

export const HEARTBEAT_INTERVAL_MS = 60_000;

export async function writeHeartbeat(db: Db) {
  await db.insert(heartbeat).values({ at: sql`now()` }).onConflictDoUpdate({ target: heartbeat.id, set: { at: sql`now()` } });
}
