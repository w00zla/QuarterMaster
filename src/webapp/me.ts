// What the logged-in user may do, read from the roster on every request (never from the session).
import { sql } from 'drizzle-orm';
import type { Db } from '../db/client.ts';
import type { Lang, MeResponse } from './api-types.ts';
import { privilegesOf } from './features.ts';
import type { Session } from './session.ts';

const CDN = 'https://cdn.discordapp.com';

/** The user's Discord avatar, or Discord's default one (new username system: (id >> 22) % 6). */
export const avatarUrl = (userId: string, avatar: string | null) => avatar
  ? `${CDN}/avatars/${userId}/${avatar}.png?size=64`
  : `${CDN}/embed/avatars/${(BigInt(userId) >> 22n) % 6n}.png`;

export async function getMe(db: Db, session: Session): Promise<MeResponse> {
  const { userId } = session;
  // Active memberships (a server the bot left has none: the bot deactivates its members)
  const orgs = await db.execute<{ guild_id: string; name: string; display_name: string }>(sql`
    SELECT o.guild_id, o.name, m.display_name
    FROM app.member m JOIN app.org o ON o.guild_id = m.guild_id
    WHERE m.user_id = ${userId} AND m.active ORDER BY lower(o.name)`);
  const [profile] = await db.execute<{ rsi_handle: string | null; lang: Lang | null }>(sql`
    SELECT (SELECT rsi_handle FROM app.app_user WHERE user_id = ${userId}) AS rsi_handle,
      (SELECT lang FROM web.user_setting WHERE user_id = ${userId}) AS lang`);
  return {
    userId,
    // Shown in the user's own header, also without any org
    name: session.globalName ?? session.username,
    username: session.username,
    avatarUrl: avatarUrl(userId, session.avatar),
    orgs: orgs.map((o) => ({ guildId: o.guild_id, name: o.name, displayName: o.display_name })),
    rsiHandle: profile?.rsi_handle ?? null,
    langOverride: profile?.lang ?? null,
    privileges: await privilegesOf(db, userId),
  };
}
