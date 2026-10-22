// Is everything running: the catalog's game build, the UEX pull per endpoint, whether the bot still works through
// the history for each logs channel, the number of user data check hits. Read-only. The bot keeps no heartbeat:
// its logs mark (bot.guild.logs_after) lagging behind rows it would post means it does not work them off.
import { sql } from 'drizzle-orm';
import type { Db } from '../db/client.ts';
import { one, rows } from '../db/query.ts';
import { logRows } from '../bot/logs.ts';
import { getMeta, uexEndpoints } from './queries.ts';
import { getDataChecks } from './users.ts';
import type { Health, StatusBotLogs, StatusResponse } from './api-types.ts';

const MINUTE = 60_000;
// The pull runs every 15 minutes (src/ext/main.ts): one missed pull is a warning, several an error
export const UEX_WARN_MINUTES = 35;
export const UEX_ERR_MINUTES = 120;
// The logs poster runs every 30 seconds (src/bot/logs.ts)
export const LOGS_WARN_MINUTES = 2;
export const LOGS_ERR_MINUTES = 10;
// Pending logs rows counted at most
const PENDING_LIMIT = 100;

const age = (iso: string | null, now: number) => (iso === null ? Infinity : (now - Date.parse(iso)) / MINUTE);
const byAge = (minutes: number, warn: number, err: number): Health => (minutes >= err ? 'err' : minutes >= warn ? 'warn' : 'ok');

export async function getStatus(db: Db): Promise<StatusResponse> {
  const now = Date.now();
  const { game } = await getMeta(db);
  const uex = (await uexEndpoints(db)).map((e) => ({ ...e, state: byAge(age(e.checkedAt, now), UEX_WARN_MINUTES, UEX_ERR_MINUTES) }));

  const guilds = await rows<{ guildId: string; org: string; level: 'stock' | 'blueprints' | 'all'; after: number | null }>(db, sql`
    SELECT g.guild_id AS "guildId", o.name AS org, g.logs_level AS level, g.logs_after::int AS after
    FROM bot.guild g JOIN app.org o ON o.guild_id = g.guild_id
    WHERE g.logs_channel_id IS NOT NULL AND g.logs_level <> 'off' AND g.left_at IS NULL
    ORDER BY lower(o.name)`);
  const botLogs: StatusBotLogs[] = [];
  for (const g of guilds) {
    // No mark yet: the bot sets it on its next round, so a lasting null means it is not running either
    if (g.after === null) {
      botLogs.push({ guildId: g.guildId, org: g.org, level: g.level, marked: false, pending: 0, oldestPendingAt: null, state: 'warn' });
      continue;
    }
    const pending = await logRows(db, g.guildId, g.after, g.level, PENDING_LIMIT);
    const oldest = pending[0] ? (await one<{ at: string }>(db, sql`
      SELECT to_json(created_at) #>> '{}' AS at FROM app.history WHERE id = ${pending[0].id}`))?.at ?? null : null;
    botLogs.push({
      guildId: g.guildId, org: g.org, level: g.level, marked: true, pending: pending.length, oldestPendingAt: oldest,
      state: oldest ? byAge(age(oldest, now), LOGS_WARN_MINUTES, LOGS_ERR_MINUTES) : 'ok',
    });
  }

  const history = (await one<{ total: number; newestAt: string | null }>(db, sql`
    SELECT count(*)::int AS total, to_json(max(created_at)) #>> '{}' AS "newestAt" FROM app.history`))!;
  // Names only matter for the hit lists, the count is all this needs
  const checkHits = (await getDataChecks(db, 'en')).reduce((sum, c) => sum + c.hits.length, 0);

  return { checkedAt: new Date(now).toISOString(), game, uex, botLogs, history, checkHits };
}
