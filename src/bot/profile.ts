// The user's bot profile: RSI handle (app.app_user, shared with the web app) and the bot's own
// language override (bot.user_config; the web app keeps its own in web.user_setting).
import { sql } from 'drizzle-orm';
import type { Db } from '../db/client.ts';
import { appUser } from '../db/schema/app.ts';
import type { Lang } from './i18n.ts';
import { setLangOverride } from './lang.ts';

export interface Profile {
  rsiHandle: string | null;
  // null = follow the Discord client language
  lang: Lang | null;
}

// Same rule as the web app's profile endpoint
const RSI_HANDLE = /^[A-Za-z0-9_-]{3,60}$/;

/** The handle as typed: '' = none (null), an invalid one = undefined. */
export function parseRsiHandle(text: string): string | null | undefined {
  const handle = text.trim();
  if (!handle) return null;
  return RSI_HANDLE.test(handle) ? handle : undefined;
}

/** Both settings in one query (it runs before the modal opens, within Discord's 3 s). */
export async function loadProfile(db: Db, userId: string): Promise<Profile> {
  const [row] = await db.execute<{ rsi_handle: string | null; lang: Lang | null }>(sql`
    SELECT (SELECT rsi_handle FROM app.app_user WHERE user_id = ${userId}) AS rsi_handle,
      (SELECT lang_override FROM bot.user_config WHERE user_id = ${userId}) AS lang`);
  return { rsiHandle: row?.rsi_handle ?? null, lang: row?.lang ?? null };
}

/**
 * Saves both. The user row is only created when there is something to keep (users without any org
 * are welcome; an empty profile leaves no row behind that the roster cleanup would never see).
 */
export async function saveProfile(db: Db, userId: string, p: Profile): Promise<void> {
  await db.transaction(async (tx) => {
    if (p.rsiHandle !== null || p.lang !== null) await tx.insert(appUser).values({ userId }).onConflictDoNothing();
    await tx.execute(sql`
      UPDATE app.app_user SET rsi_handle = ${p.rsiHandle}, updated_at = now()
      WHERE user_id = ${userId} AND rsi_handle IS DISTINCT FROM ${p.rsiHandle}`);
  });
  // After the commit: bot.user_config references the user row, and the cache must match the table
  await setLangOverride(db, userId, p.lang);
}
