// The logs channel: one line per change, in the server's base language. Level `stock` posts sharing and
// taking back in this org, gives among its members and bookings on batches shared in it (`details.sharedIn`
// of the history row); level `blueprints` the blueprints its active members add or remove; `all` both.
// Unshared stock and refinery jobs are private and never posted. The source is app.history; `bot.guild.logs_after` marks the last row
// handled, so a restart neither loses nor repeats lines (the mark moves after each message; a crash between
// a post and its mark repeats at most that message).
import { DiscordAPIError, RESTJSONErrorCodes, type Client } from 'discord.js';
import { sql, type SQL } from 'drizzle-orm';
import type { Db } from '../db/client.ts';
import { rows } from '../db/query.ts';
import { formatAmount } from '../stock/amount.ts';
import { statsText } from '../stock/component-stats.ts';
import { locationCatalog, materialCatalog, missingNames } from '../stock/lookup.ts';
import { blueprintCatalog } from './blueprints.ts';
import { t, type Lang, type MessageKey } from './i18n.ts';
import { escapeMarkdown } from './markdown.ts';
import type { LogsLevel } from './settings.ts';

export interface LogRow {
  id: number;
  action: string;
  actorUserId: string;
  toOwnerUserId: string | null;
  // The org the share, take-back or give happened in
  guildId: string | null;
  targetKind: 'resource' | 'item' | 'blueprint';
  targetUuid: string;
  details: {
    amount?: string; batchAmount?: string; from?: string; quality?: number; locationUuid?: string; toLocationUuid?: string;
    // Ship components: the batch's stats, and on an adjust that changed them the ones before
    stats?: Record<string, string>; statsFrom?: Record<string, string>;
  };
}

// Rows per guild and round; the rest follows next round
const BATCH = 50;
// Discord's limit per message
const MAX_MESSAGE = 2000;

/** This org's rows after `after` for the level, oldest first. */
export function logRows(db: Db, guildId: string, after: number, level: Exclude<LogsLevel, 'off'>, limit = BATCH): Promise<LogRow[]> {
  const activeActor = sql`EXISTS (SELECT 1 FROM app.member m WHERE m.guild_id = ${guildId} AND m.user_id = actor_user_id AND m.active)`;
  const wanted: SQL[] = [];
  if (level !== 'blueprints') {
    wanted.push(sql`(category = 'stock' AND (
      (guild_id = ${guildId} AND action IN ('share', 'unshare', 'give'))
      OR (details->'sharedIn' @> jsonb_build_array(${guildId}::text) AND action IN ('add', 'remove', 'adjust', 'move', 'merge', 'give')
        AND ${activeActor})))`);
  }
  if (level !== 'stock') wanted.push(sql`(category = 'blueprint' AND action IN ('add', 'remove') AND ${activeActor})`);
  return rows<LogRow>(db, sql`
    SELECT id::int AS id, action, actor_user_id AS "actorUserId", to_owner_user_id AS "toOwnerUserId", guild_id AS "guildId",
      target_kind AS "targetKind", target_uuid AS "targetUuid", details
    FROM app.history
    WHERE id > ${after} AND (${sql.join(wanted, sql` OR `)})
    ORDER BY id LIMIT ${limit}`);
}

export interface LogNames {
  material: (uuid: string) => string;
  // Ship components: their stats as text ("" without any); null for every other material
  stats?: (uuid: string, stats: Record<string, string> | undefined) => string | null;
  location: (uuid: string | undefined) => string;
  blueprint: (uuid: string) => string;
}

/** One line for a row as the channel of `guildId` shows it; people as mentions (rendered as names, never pinging). */
export function logLine(r: LogRow, guildId: string, names: LogNames, lang: Lang): string {
  if (r.targetKind === 'blueprint') {
    const vars = { who: `<@${r.actorUserId}>`, what: `**${escapeMarkdown(names.blueprint(r.targetUuid))}**` };
    return t(lang, r.action === 'remove' ? 'logs.blueprintRemove' : 'logs.blueprintAdd', vars);
  }
  const unit = t(lang, r.targetKind === 'item' ? 'unit.pcs' : 'unit.scu');
  const amount = (a: string | undefined) => (a === undefined ? '' : `**${formatAmount(a)} ${unit}** · `);
  const name = `**${escapeMarkdown(names.material(r.targetUuid))}**`;
  // A component shows its stats instead of a quality
  const statsOf = (s: Record<string, string> | undefined) => names.stats?.(r.targetUuid, s) ?? null;
  const stats = statsOf(r.details.stats);
  const what = stats === null ? `${name} Q${r.details.quality ?? '?'}` : [name, stats && escapeMarkdown(stats)].filter(Boolean).join(' · ');
  const where = escapeMarkdown(names.location(r.details.locationUuid));
  const vars = { who: `<@${r.actorUserId}>`, amount: amount(r.details.amount), what, where };
  // A give seen from another org the batch was shared in: the recipient is none of its business
  if (r.action === 'give' && r.guildId === guildId && r.toOwnerUserId) return t(lang, 'logs.give', { ...vars, to: `<@${r.toOwnerUserId}>` });
  if (r.action === 'give') return t(lang, 'logs.giveAway', vars);
  if (r.action === 'adjust') {
    const [from, to] = [formatAmount(r.details.from ?? '?'), formatAmount(r.details.amount ?? '?')];
    const amounts = `${from} → ${to} ${unit}`;
    if (r.details.statsFrom === undefined) return t(lang, 'logs.adjust', { ...vars, change: amounts });
    // A component's stats changed (and maybe its amount): old → new stats, the name without them
    const statsLine = (s: Record<string, string> | undefined) => escapeMarkdown(statsOf(s) || t(lang, 'logs.noStats'));
    const change = [from !== to ? amounts : null, `${statsLine(r.details.statsFrom)} → ${statsLine(r.details.stats)}`].filter(Boolean).join(' · ');
    return t(lang, 'logs.adjust', { ...vars, what: name, change });
  }
  if (r.action === 'move') return t(lang, 'logs.move', { ...vars, to: escapeMarkdown(names.location(r.details.toLocationUuid)) });
  // What the batch holds now (rows before it was recorded have no such amount)
  if (r.action === 'add' && r.details.batchAmount !== undefined) {
    return t(lang, 'logs.addTotal', { ...vars, total: `${formatAmount(r.details.batchAmount)} ${unit}` });
  }
  if (r.action === 'remove' && r.details.batchAmount !== undefined) {
    if (formatAmount(r.details.batchAmount) === '0') return t(lang, 'logs.removeEmpty', vars);
    return t(lang, 'logs.removeLeft', { ...vars, left: `${formatAmount(r.details.batchAmount)} ${unit}` });
  }
  return t(lang, `logs.${r.action}` as MessageKey, vars);
}

/** Lines joined into as few messages as Discord takes; `lastId` is the last history row a message covers. */
export function packRows(items: { id: number; line: string }[]): { text: string; lastId: number }[] {
  const messages: { text: string; lastId: number }[] = [];
  let current = '';
  let lastId = 0;
  for (const { id, line } of items) {
    const fitting = line.length > MAX_MESSAGE ? `${line.slice(0, MAX_MESSAGE - 1)}…` : line;
    if (current && current.length + 1 + fitting.length > MAX_MESSAGE) {
      messages.push({ text: current, lastId });
      current = '';
    }
    current = current ? `${current}\n${fitting}` : fitting;
    lastId = id;
  }
  if (current) messages.push({ text: current, lastId });
  return messages;
}

/** Lines joined into as few messages as Discord takes. */
export function messagesOf(lines: string[]): string[] {
  return packRows(lines.map((line, id) => ({ id, line }))).map((m) => m.text);
}

/** Catalog names in `lang`, retired ones too. */
async function namesFor(db: Db, lang: Lang, logRowsList: LogRow[]): Promise<LogNames> {
  const [materials, locations, blueprints] = [await materialCatalog(db, lang), await locationCatalog(db, lang), await blueprintCatalog(db, lang)];
  const stock = logRowsList.filter((r) => r.targetKind !== 'blueprint');
  const places = stock.flatMap((r) => [r.details.locationUuid, r.details.toLocationUuid]).filter((u): u is string => !!u);
  const missing = await missingNames(db, lang,
    [...new Set(stock.map((r) => r.targetUuid).filter((u) => !materials.has(u)))],
    [...new Set(places.filter((u) => !locations.has(u)))]);
  return {
    // Components by their unique label, like /qm-gear names them
    material: (uuid) => {
      const m = materials.get(uuid);
      return (m?.component ? m.label : m?.name) ?? missing.get(uuid) ?? '?';
    },
    stats: (uuid, stats) => {
      const m = materials.get(uuid);
      return m?.component ? statsText(m.stats, stats ?? null) : null;
    },
    location: (uuid) => (uuid ? locations.get(uuid)?.short ?? missing.get(uuid) ?? '?' : '?'),
    // The catalog holds retired blueprints too
    blueprint: (uuid) => blueprints.byUuid.get(uuid)?.label ?? '?',
  };
}

// The channel cannot be used (gone, no access): its lines are skipped, not kept for later
const PERMANENT = new Set<number>([RESTJSONErrorCodes.UnknownChannel, RESTJSONErrorCodes.MissingAccess, RESTJSONErrorCodes.MissingPermissions]);

// The configured channel is not a channel the bot can write to
class UnusableChannel extends Error {}

type Log = (message: string, err?: unknown) => void;

interface LogsGuild { guildId: string; channelId: string; lang: Lang; level: Exclude<LogsLevel, 'off'>; after: number | null }

/** Polls the history and posts each org's new lines into its logs channel. */
export class LogsPoster {
  private readonly client: Client;
  private readonly db: Db;
  private readonly log: Log;
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(client: Client, db: Db, log: Log) {
    this.client = client;
    this.db = db;
    this.log = log;
  }

  start(intervalMs = 30_000) {
    this.timer ??= setInterval(() => void this.round(), intervalMs);
    void this.round();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** One pass over every server with a logs channel; overlapping passes are skipped. */
  async round(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const guilds = await rows<LogsGuild>(this.db, sql`
        SELECT guild_id AS "guildId", logs_channel_id AS "channelId", base_lang AS lang, logs_level AS level, logs_after::int AS after
        FROM bot.guild WHERE logs_channel_id IS NOT NULL AND logs_level <> 'off' AND left_at IS NULL`);
      for (const g of guilds) {
        try {
          await this.post(g);
        } catch (err) {
          this.log(`Logs for guild ${g.guildId} failed`, err);
        }
      }
    } catch (err) {
      this.log('Logs round failed', err);
    } finally {
      this.running = false;
    }
  }

  private async post(g: LogsGuild) {
    // No mark yet: start at the newest row (the past is never posted)
    if (g.after === null) {
      await this.db.execute(sql`UPDATE bot.guild SET logs_after = (SELECT coalesce(max(id), 0) FROM app.history) WHERE guild_id = ${g.guildId}`);
      return;
    }
    const found = await logRows(this.db, g.guildId, g.after, g.level);
    if (!found.length) return;
    const last = found[found.length - 1]!.id;
    const names = await namesFor(this.db, g.lang, found);
    // A row that cannot be worded is skipped, it must not stop the server's log for good
    const items: { id: number; line: string }[] = [];
    for (const r of found) {
      try {
        items.push({ id: r.id, line: logLine(r, g.guildId, names, g.lang) });
      } catch (err) {
        this.log(`Logs for guild ${g.guildId}: history row ${r.id} skipped`, err);
      }
    }
    // Only forward and one step at a time: a message that went out is marked at once, so a later failure
    // does not repeat it; /qm-setup may have reset the mark meanwhile (then nothing matches and we stop)
    let mark = g.after;
    const advance = async (id: number) => {
      const res = await this.db.execute(sql`UPDATE bot.guild SET logs_after = ${id} WHERE guild_id = ${g.guildId} AND logs_after = ${mark}`);
      if (res.count === 0) return false;
      mark = id;
      return true;
    };
    try {
      const channel = await this.client.channels.fetch(g.channelId);
      if (!channel?.isSendable()) throw new UnusableChannel(`Logs channel ${g.channelId} of guild ${g.guildId} cannot take messages`);
      for (const m of packRows(items)) {
        await channel.send({ content: m.text, allowedMentions: { parse: [] } });
        if (!(await advance(m.lastId))) return;
      }
    } catch (err) {
      // Network or Discord trouble (5xx, rate limit): try again next round; a channel that cannot be used: skip these lines
      const permanent = err instanceof UnusableChannel || (err instanceof DiscordAPIError && PERMANENT.has(Number(err.code)));
      this.log(`Logs channel ${g.channelId} of guild ${g.guildId}: ${permanent ? 'lines skipped' : 'retrying'}`, err);
      if (!permanent) return;
    }
    await advance(last);
  }
}
