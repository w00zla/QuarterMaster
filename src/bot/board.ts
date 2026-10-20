// The board: one message per org in its board channel, kept current with what the org offers (the
// figures of the web app's org tile, the shared materials), in the server's base language. Only orgs
// whose data changed are rendered again: the database's change announcements (qm_changes, from the web
// app's triggers) mark them, and a rendered board is compared with the last one before it is edited.
// Never unshared stock, refinery jobs or names of holders.
import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, ContainerBuilder, DiscordAPIError, RESTJSONErrorCodes, SectionBuilder, SeparatorBuilder,
  SeparatorSpacingSize, TextDisplayBuilder, ThumbnailBuilder, type Client,
} from 'discord.js';
import { sql } from 'drizzle-orm';
import type postgres from 'postgres';
import type { Db } from '../db/client.ts';
import { rows } from '../db/query.ts';
import { materialCatalog, missingNames } from '../stock/lookup.ts';
import { obtainableBlueprints, orgMaterials, orgMetrics, type OrgMaterial, type OrgMetrics } from '../stock/org-summary.ts';
import { qMark } from '../stock/quality.ts';
import { t, type Lang } from './i18n.ts';
import { escapeMarkdown } from './markdown.ts';
import { customId, panel, webAppButton, webAppPath } from './ui.ts';

// Material lines per kind; the rest is counted
export const BOARD_LINES = 10;
// The container's accent (the logo's amber), the same for every org
const ACCENT = 0xe0913a;

export interface BoardData {
  // The board's title (the org name unless set) and its optional subtitle
  orgName: string;
  subtitle: string | null;
  metrics: OrgMetrics;
  obtainable: number;
  materials: Array<OrgMaterial & { name: string }>;
}

export const BOARD_STYLES = ['list', 'table'] as const;
// list: figures and materials as text lines; table: code-block tables with aligned columns
export type BoardStyle = (typeof BOARD_STYLES)[number];

// Longest material name in a table; longer ones are cut
const TABLE_NAME = 22;

/** Monospace columns: padded (right-aligned where `right`), the last column as it is (its width may vary). */
export function textTable(rows: string[][], right: boolean[]): string {
  const widths = rows[0]!.map((_, i) => Math.max(...rows.map((r) => r[i]!.length)));
  return rows.map((r) => r.map((c, i) => (i === r.length - 1 ? c : right[i] ? c.padStart(widths[i]!) : c.padEnd(widths[i]!)))
    .join('   ').trimEnd()).join('\n');
}

/**
 * The board message: head (its title or the org name, the server icon when there is one), figures, one section per kind of
 * material, buttons, the time of the last change. `data`, style and icon decide whether it changed.
 */
export function boardMessage(d: BoardData, guildId: string, lang: Lang, updatedAt: Date, iconUrl: string | null = null,
  style: BoardStyle = 'list') {
  const tr = (key: Parameters<typeof t>[1], vars?: Parameters<typeof t>[2]) => t(lang, key, vars);
  const { metrics: m } = d;
  // Ship components have their own section (no quality); items are the rest
  type Section = 'resource' | 'item' | 'component';
  const ofKind = (kind: Section) => d.materials.filter((x) => (kind === 'component' ? x.component : x.kind === kind && !x.component));
  const unit = (kind: Section) => tr(kind === 'resource' ? 'unit.scu' : 'unit.pcs');
  const heading = (kind: Section) => tr(kind === 'component' ? 'board.components' : kind === 'item' ? 'board.items' : 'board.resources');
  const more = (all: unknown[]) => (all.length > BOARD_LINES ? tr('board.more', { count: all.length - BOARD_LINES }) : null);

  // Best quality first, with its level like the web app shows it
  const listSection = (kind: Section) => {
    const all = ofKind(kind);
    if (!all.length) return null;
    const lines = all.slice(0, BOARD_LINES).map((x) => {
      const vars = {
        name: escapeMarkdown(x.name),
        amount: `${x.total} ${unit(kind)}`,
        quality: `${qMark(x.bestQuality)} ${x.bestQuality}`,
        // Always plural: one holder rarely stays alone
        holders: tr('board.holders', { count: x.holders }),
      };
      return tr(kind === 'component' ? 'board.componentLine' : 'board.line', vars);
    });
    const rest = more(all);
    if (rest) lines.push(`-# ${rest}`);
    return [heading(kind), ...lines].join('\n');
  };
  // Code blocks show names as they are (no Markdown); the stars go last, their width differs between fonts
  const tableSection = (kind: Section) => {
    const all = ofKind(kind);
    if (!all.length) return null;
    const cut = (name: string) => (name.length > TABLE_NAME ? `${name.slice(0, TABLE_NAME - 1)}…` : name);
    const component = kind === 'component';
    const name = tr(component ? 'board.col.component' : kind === 'item' ? 'board.col.item' : 'board.col.material');
    let body = textTable([
      [name, tr('board.col.amount'), tr('board.col.holders'), ...(component ? [] : [tr('board.col.quality')])],
      ...all.slice(0, BOARD_LINES).map((x) => [
        cut(x.name), `${x.total} ${unit(kind)}`, String(x.holders),
        ...(component ? [] : [`${String(x.bestQuality).padStart(4)} ${qMark(x.bestQuality)}`]),
      ]),
    ], [false, true, true, false]);
    const rest = more(all);
    if (rest) body += `\n${rest}`;
    return `${heading(kind)}\n\`\`\`\n${body.replaceAll('`', "'")}\n\`\`\``;
  };

  const figures = style === 'table'
    ? `\`\`\`\n${textTable([
      [tr('board.col.members'), String(m.members), '', tr('board.col.blueprints'), `${m.blueprints} / ${d.obtainable}`],
      [tr('board.col.resources'), `${m.resources.scu} ${unit('resource')}`, '', tr('board.col.kinds'), String(m.resources.kinds)],
      [tr('board.col.items'), `${m.items.pieces} ${unit('item')}`, '', tr('board.col.kinds'), String(m.items.kinds)],
      [tr('board.col.components'), `${m.components.pieces} ${unit('component')}`, '', tr('board.col.kinds'), String(m.components.kinds)],
    ], [false, true, false, false, false])}\n\`\`\``
    : [
      tr('board.people', { members: m.members, blueprints: m.blueprints, obtainable: d.obtainable }),
      tr('board.resourceFigures', { amount: m.resources.scu, kinds: m.resources.kinds, locations: m.resources.locations }),
      tr('board.itemFigures', { amount: m.items.pieces, kinds: m.items.kinds, locations: m.items.locations }),
      tr('board.componentFigures', { amount: m.components.pieces, kinds: m.components.kinds, locations: m.components.locations }),
    ].join('\n');
  const section = style === 'table' ? tableSection : listSection;
  const sections = [section('resource'), section('item'), section('component')].filter((s): s is string => s !== null);

  const buttons = [
    new ButtonBuilder().setCustomId(customId('qm-stock', 'org')).setLabel(tr('board.btn.showAll')).setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(customId('qm-comps', 'org')).setLabel(tr('board.btn.showComponents')).setStyle(ButtonStyle.Secondary),
    webAppButton(lang, webAppPath.stock(guildId), tr('board.btn.stock')),
    webAppButton(lang, webAppPath.components(guildId), tr('board.btn.components')),
    webAppButton(lang, webAppPath.blueprints(guildId), tr('board.btn.blueprints')),
  ].filter((b): b is ButtonBuilder => !!b);
  const container = new ContainerBuilder().setAccentColor(ACCENT);
  const title = tr('board.title', { org: escapeMarkdown(d.orgName) });
  const head = new TextDisplayBuilder().setContent(d.subtitle ? `${title}\n-# ${escapeMarkdown(d.subtitle)}` : title);
  if (iconUrl) {
    container.addSectionComponents(new SectionBuilder().addTextDisplayComponents(head)
      .setThumbnailAccessory(new ThumbnailBuilder().setURL(iconUrl)));
  } else {
    container.addTextDisplayComponents(head);
  }
  container.addTextDisplayComponents(new TextDisplayBuilder().setContent(figures));
  // The list sets the materials apart with a line; the tables (with their own headings) need none
  if (style === 'list') container.addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Large));
  if (!sections.length) container.addTextDisplayComponents(new TextDisplayBuilder().setContent(tr('board.empty')));
  sections.forEach((s, i) => {
    // Space between the kinds, no line
    if (i && style === 'list') container.addSeparatorComponents(new SeparatorBuilder().setDivider(false));
    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(s));
  });
  container.addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Large))
    .addActionRowComponents(new ActionRowBuilder<ButtonBuilder>().addComponents(buttons))
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(
      `-# ${tr('board.updated', { time: `<t:${Math.floor(updatedAt.getTime() / 1000)}:R>` })}`));
  return panel(container);
}

/** What the board of `guildId` shows (names in `lang`, retired materials too). */
export async function boardData(db: Db, guildId: string, orgName: string, lang: Lang, subtitle: string | null = null): Promise<BoardData> {
  const metrics = (await orgMetrics(db, [guildId])).get(guildId)!;
  const found = await orgMaterials(db, guildId);
  const catalog = await materialCatalog(db, lang);
  const missing = await missingNames(db, lang, found.filter((x) => !catalog.has(x.uuid)).map((x) => x.uuid), []);
  return {
    orgName,
    subtitle,
    metrics,
    obtainable: await obtainableBlueprints(db),
    materials: found.map((x) => ({ ...x, name: catalog.get(x.uuid)?.name ?? missing.get(x.uuid) ?? '?' })),
  };
}

// The channel cannot be used (gone, no access): the board waits for the next change
const PERMANENT = new Set<number>([RESTJSONErrorCodes.UnknownChannel, RESTJSONErrorCodes.MissingAccess, RESTJSONErrorCodes.MissingPermissions]);

class UnusableChannel extends Error {}

type Log = (message: string, err?: unknown) => void;

interface BoardGuild {
  guildId: string;
  channelId: string;
  messageId: string | null;
  lang: Lang;
  orgName: string;
  subtitle: string | null;
  style: BoardStyle;
}

// /qm-setup changes what a board shows (language, channel, style) in this process: it asks the poster directly
let updateHandler: ((guildId: string) => void) | null = null;
export const requestBoardUpdate = (guildId: string) => updateHandler?.(guildId);

/** Keeps every org's board current: renders the orgs marked as changed, every 30 s. */
export class BoardPoster {
  private readonly client: Client;
  private readonly db: Db;
  private readonly log: Log;
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  // At start every board is checked once: what changed while the bot was down was not heard
  private all = true;
  private readonly guilds = new Set<string>();
  // Users whose blueprints changed: their orgs, looked up in the next round
  private readonly users = new Set<string>();
  // The data each board shows (JSON), to skip edits that change nothing
  private readonly shown = new Map<string, string>();
  private importId: number | null = null;

  constructor(client: Client, db: Db, log: Log) {
    this.client = client;
    this.db = db;
    this.log = log;
    updateHandler = (guildId) => this.markGuild(guildId);
  }

  markGuild(guildId: string) {
    this.guilds.add(guildId);
  }

  markUser(userId: string) {
    this.users.add(userId);
  }

  markAll() {
    this.all = true;
  }

  /** A change announcement from the database (`{t, g, u}`). */
  onChange(payload: string) {
    let change: { t?: unknown; g?: unknown; u?: unknown };
    try {
      change = JSON.parse(payload) as typeof change;
    } catch (err) {
      this.log(`Unexpected change payload: ${payload}`, err);
      return;
    }
    // Stock shared in an org, its roster and name; a stock row without an org is personal
    if (typeof change.g === 'string') this.markGuild(change.g);
    // Blueprints come per user: every org they are an active member of
    else if (change.t === 'blueprint' && typeof change.u === 'string') this.markUser(change.u);
  }

  start(intervalMs = 30_000) {
    this.timer ??= setInterval(() => void this.round(), intervalMs);
    void this.round();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** One pass over the marked orgs that have a board; overlapping passes are skipped. */
  async round(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      // A newer catalog import may rename materials on every board
      const [latest] = await rows<{ id: number | null }>(this.db, sql`SELECT max(id)::int AS id FROM catalog.import`);
      if (latest && latest.id !== this.importId) {
        if (this.importId !== null) this.all = true;
        this.importId = latest.id;
      }
      if (!this.all && !this.guilds.size && !this.users.size) return;
      const all = this.all;
      const marked = [...this.guilds];
      const users = [...this.users];
      this.all = false;
      this.guilds.clear();
      this.users.clear();
      if (users.length) {
        const ids = sql.join(users.map((u) => sql`${u}`), sql`, `);
        marked.push(...(await rows<{ guildId: string }>(this.db, sql`
          SELECT DISTINCT guild_id AS "guildId" FROM app.member WHERE active AND user_id IN (${ids})`)).map((r) => r.guildId));
      }
      if (!all && !marked.length) return;
      const only = all ? sql`` : sql`AND g.guild_id IN (${sql.join(marked.map((g) => sql`${g}`), sql`, `)})`;
      const boards = await rows<BoardGuild>(this.db, sql`
        SELECT g.guild_id AS "guildId", g.board_channel_id AS "channelId", g.board_message_id AS "messageId", g.base_lang AS lang,
          g.board_style AS style, coalesce(g.board_title, o.name) AS "orgName", g.board_subtitle AS subtitle
        FROM bot.guild g JOIN app.org o ON o.guild_id = g.guild_id
        WHERE g.board_channel_id IS NOT NULL AND g.left_at IS NULL ${only}`);
      for (const b of boards) {
        try {
          await this.update(b);
        } catch (err) {
          // Network or Discord trouble (5xx, rate limit): again next round; a channel that cannot be used waits for the next change
          const permanent = err instanceof UnusableChannel || (err instanceof DiscordAPIError && PERMANENT.has(Number(err.code)));
          this.log(`Board of guild ${b.guildId} in channel ${b.channelId}: ${permanent ? 'skipped' : 'retrying'}`, err);
          if (!permanent) this.markGuild(b.guildId);
        }
      }
    } catch (err) {
      // Nothing was rendered: everything again next round
      this.all = true;
      this.log('Board round failed', err);
    } finally {
      this.running = false;
    }
  }

  private async update(b: BoardGuild) {
    const data = await boardData(this.db, b.guildId, b.orgName, b.lang, b.subtitle);
    // The server icon from the gateway cache (none while the server is unavailable)
    const icon = this.client.guilds.cache.get(b.guildId)?.iconURL({ extension: 'png', size: 128 }) ?? null;
    const key = JSON.stringify([b.lang, b.channelId, b.style, icon, data]);
    if (b.messageId && this.shown.get(b.guildId) === key) return;
    const message = boardMessage(data, b.guildId, b.lang, new Date(), icon, b.style);
    const channel = await this.client.channels.fetch(b.channelId);
    if (!channel?.isSendable()) throw new UnusableChannel(`Board channel ${b.channelId} of guild ${b.guildId} cannot take messages`);
    let edited = false;
    if (b.messageId) {
      try {
        await channel.messages.edit(b.messageId, message);
        edited = true;
      } catch (err) {
        // Deleted by someone: post a new one
        if (!(err instanceof DiscordAPIError && err.code === RESTJSONErrorCodes.UnknownMessage)) throw err;
      }
    }
    if (!edited) {
      const posted = await channel.send(message);
      // Only while the channel is still the board channel (/qm-setup may have changed it meanwhile)
      await this.db.execute(sql`
        UPDATE bot.guild SET board_message_id = ${posted.id} WHERE guild_id = ${b.guildId} AND board_channel_id = ${b.channelId}`);
    }
    this.shown.set(b.guildId, key);
  }
}

/** Feeds the database's change announcements into the poster; every (re)connect marks all boards. */
export function listenForBoardChanges(client: postgres.Sql, poster: BoardPoster) {
  return client.listen('qm_changes', (payload) => poster.onChange(payload), () => poster.markAll());
}
