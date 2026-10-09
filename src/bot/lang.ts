// The user's language for private output: the override from /qm-profile (bot.user_config), else the
// client locale. Cached in memory (autocomplete must answer fast); /qm-profile writes through here.
import { sql } from 'drizzle-orm';
import type { Db } from '../db/client.ts';
import { userLang, type Lang } from './i18n.ts';

// userId -> override (null = follow the locale); the bot is the only writer of bot.user_config
const overrides = new Map<string, Lang | null>();

export async function langOverride(db: Db, userId: string): Promise<Lang | null> {
  if (overrides.has(userId)) return overrides.get(userId)!;
  const [row] = await db.execute<{ lang: Lang | null }>(sql`SELECT lang_override AS lang FROM bot.user_config WHERE user_id = ${userId}`);
  const lang = row?.lang ?? null;
  overrides.set(userId, lang);
  return lang;
}

/** Language for this user's private output; without a database (router tests) the locale alone. */
export async function resolveLang(db: Db | undefined, userId: string, locale: string | null | undefined): Promise<Lang> {
  return (db ? await langOverride(db, userId) : null) ?? userLang(locale);
}

/**
 * Stores the override; null deletes the row (it is the table's only setting, and a row keeps the user's
 * app_user row alive in the roster cleanup). The app_user row must exist for a language.
 */
export async function setLangOverride(db: Db, userId: string, lang: Lang | null): Promise<void> {
  if (lang === null) await db.execute(sql`DELETE FROM bot.user_config WHERE user_id = ${userId}`);
  else {
    await db.execute(sql`
      INSERT INTO bot.user_config (user_id, lang_override) VALUES (${userId}, ${lang})
      ON CONFLICT (user_id) DO UPDATE SET lang_override = excluded.lang_override, updated_at = now()`);
  }
  overrides.set(userId, lang);
}
