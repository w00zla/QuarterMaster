// /qm-stock: book, take out, move, correct, list and find stock. Every change of existing stock
// (remove, move, adjust) is shown first and only booked after the initiator confirms.
import {
  ActionRowBuilder, ApplicationCommandOptionType, ApplicationIntegrationType, ButtonBuilder, ButtonStyle,
  InteractionContextType, escapeMarkdown, type APIApplicationCommandOption, type AutocompleteInteraction, type MessageComponentInteraction,
} from 'discord.js';
import type { Db } from '../../db/client.ts';
import { formatMicros, toMicros } from '../../planner/plan.ts';
import { formatAmount, parseAmount } from '../../stock/amount.ts';
import {
  findStock, locationCatalog, materialCatalog, materialTotal, pickableBatches, stockList, type BatchPick, type PickableBatch, type StockFilter,
} from '../../stock/lookup.ts';
import * as stock from '../../stock/service.ts';
import { requireMember } from '../access.ts';
import { rosterEntry } from '../blueprints.ts';
import { UserError } from '../errors.ts';
import { localizedDescription, t, type Lang, type MessageKey, type MessageVars } from '../i18n.ts';
import { batchChoices, batchLabel, locationChoices, materialChoices, type Choice } from '../pickers.ts';
import { bySubcommand, type BotCommand, type CommandContext } from '../registry.ts';
import { accessOf, memberInfo, searchMembers } from '../roster.ts';
import { findGuildSettings } from '../settings.ts';
import { CONFIRM_TTL_MS, getState, LIST_TTL_MS, putState } from '../state.ts';

const NAME = 'qm-stock';
const PAGE_SIZE = 20;
const MAX_FIND = 25;

// Option JSON with a localized description; Discord validates the shape on registration
const opt = (name: string, key: MessageKey, type: ApplicationCommandOptionType, extra: Record<string, unknown> = {}) =>
  ({ name, ...localizedDescription(key), type, ...extra }) as APIApplicationCommandOption;
const S = ApplicationCommandOptionType.String;
const auto = { autocomplete: true };

const actorOf = (a: { userId: string; guildId: string; officer: boolean }): stock.Actor => ({ userId: a.userId, guildId: a.guildId, officer: a.officer, source: 'bot' });

/** Runs a stock operation; refusals become messages in the user's language. */
async function book<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    if (err instanceof stock.StockError) throw new UserError(`stock.err.${err.code}`);
    throw err;
  }
}

const unit = (lang: Lang, kind: string) => t(lang, kind === 'item' ? 'unit.pcs' : 'unit.scu');
const amountText = (lang: Lang, amount: string, kind: string) => `${formatAmount(amount)} ${unit(lang, kind)}`;
const what = (p: PickableBatch, lang: Lang, asTotal = false) => escapeMarkdown(batchLabel(p, lang, asTotal));

/** The batch as the actor may change it (also checks that it exists and is theirs to change). */
async function pickedBatch(ctx: CommandContext, actor: stock.Actor, pick: BatchPick): Promise<PickableBatch> {
  const id = Number(ctx.interaction.options.getString('batch', true));
  const found = Number.isInteger(id) ? (await pickableBatches(ctx.db, actor, pick, ctx.lang)).find((p) => p.batch.id === id) : undefined;
  if (!found) throw new UserError('stock.err.batchNotFound');
  return found;
}

/** A batch as it looks after a booking (names from the catalog caches). */
async function describe(db: Db, batch: stock.Batch, lang: Lang): Promise<PickableBatch> {
  const [materials, locations] = [await materialCatalog(db, lang), await locationCatalog(db, lang)];
  const holder = batch.designation === 'org' ? (await rosterEntry(db, batch.guildId!, batch.ownerUserId))?.displayName ?? null : null;
  return {
    batch,
    material: materials.get(batch.resourceUuid ?? batch.itemUuid!)?.name ?? '?',
    location: locations.get(batch.locationUuid)?.short ?? '?',
    holderName: holder,
    // The bot shows no refinery job details
    refine: null,
  };
}

/** " · In stock (Org): 30 SCU": the material in the stock the booking ended in (personal of its owner, or the org's). */
async function totalSuffix(db: Db, lang: Lang, b: Pick<stock.Batch, 'guildId' | 'ownerUserId' | 'resourceUuid' | 'itemUuid' | 'kind'>) {
  const scope = b.guildId ? { guildId: b.guildId } : { personalOf: b.ownerUserId };
  const total = await materialTotal(db, scope, b.resourceUuid ?? b.itemUuid!);
  const scopeName = t(lang, b.guildId ? 'stock.org' : 'stock.personal');
  return ` · ${t(lang, 'stock.inStock', { scope: scopeName, amount: amountText(lang, total, b.kind) })}`;
}

// --- confirmations ---------------------------------------------------------------------------

export type Pending =
  | { op: 'remove'; batchId: number; amount: string | null; expected: string }
  | { op: 'adjust'; batchId: number; amount: string; expected: string }
  | { op: 'move'; batchId: number; amount: string | null; expected: string; toLocationUuid?: string; toOrg?: boolean; toHolderUserId?: string };

function confirmButtons(token: string, lang: Lang) {
  return [new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`${NAME}:confirm:${token}`).setLabel(t(lang, 'btn.confirm')).setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(`${NAME}:cancel:${token}`).setLabel(t(lang, 'btn.cancel')).setStyle(ButtonStyle.Secondary),
  )];
}

async function askConfirmation(ctx: CommandContext, userId: string, pending: Pending, question: string) {
  const token = putState(userId, pending, CONFIRM_TTL_MS);
  await ctx.reply({ content: question, components: confirmButtons(token, ctx.lang), allowedMentions: { parse: [] } });
}

/** Books a confirmed change with the rights the user has now; text for the updated message. */
export async function runPending(db: Db, actor: stock.Actor, p: Pending, lang: Lang): Promise<string> {
  if (p.op === 'remove') {
    const before = (await pickableBatches(db, actor, 'change', lang)).find((x) => x.batch.id === p.batchId);
    const r = await book(() => stock.remove(db, actor, { batchId: p.batchId, amount: p.amount, expected: p.expected }));
    const kind = r.journal[0]!.kind;
    const removed = amountText(lang, r.journal[0]!.delta.replace(/^-/, ''), kind);
    // What is left of the batch, or the batch as it was with "batch empty"
    const result = r.batch ? what(await describe(db, r.batch, lang), lang, true) : `${before ? what(before, lang) : ''} · ${t(lang, 'stock.empty')}`;
    return t(lang, 'stock.removed', { amount: removed, what: result }) + await totalSuffix(db, lang, r.journal[0]!);
  }
  if (p.op === 'adjust') {
    const r = await book(() => stock.adjust(db, actor, { batchId: p.batchId, amount: p.amount, expected: p.expected }));
    const j = r.journal[0]!;
    const delta = `${j.delta.startsWith('-') ? '' : '+'}${amountText(lang, j.delta, j.kind)}`;
    const after = r.batch ? what(await describe(db, r.batch, lang), lang, true) : t(lang, 'stock.empty');
    return t(lang, 'stock.adjusted', { delta, what: after }) + await totalSuffix(db, lang, j);
  }
  const r = await book(() => stock.move(db, actor, p));
  const j = r.journal[1]!;
  return t(lang, 'stock.moved', { amount: amountText(lang, j.delta, j.kind), what: what(await describe(db, r.batch!, lang), lang, true) })
    + await totalSuffix(db, lang, r.batch!);
}

async function onConfirmButton(interaction: MessageComponentInteraction, db: Db, lang: Lang, action: string, token: string): Promise<void> {
  const state = getState<Pending>(token, interaction.user.id, true);
  if (!state.ok && state.reason === 'foreign') throw new UserError('stock.foreign');
  if (!state.ok || action === 'cancel') {
    await interaction.update({ content: t(lang, state.ok ? 'stock.cancelled' : 'stock.expired'), components: [] });
    return;
  }
  const access = await requireMember(db, interaction);
  try {
    const text = await runPending(db, actorOf(access), state.value, lang);
    await interaction.update({ content: text, components: [], allowedMentions: { parse: [] } });
  } catch (err) {
    // A refused booking replaces the question, so the buttons cannot be clicked again
    if (!(err instanceof UserError)) throw err;
    await interaction.update({ content: t(lang, err.key, err.vars), components: [] });
  }
}

// --- lists -----------------------------------------------------------------------------------

interface ListQuery {
  filter: StockFilter;
  org: boolean;
}

export function listPage(entries: PickableBatch[], org: boolean, page: number, lang: Lang, token: string) {
  const tr = (key: MessageKey, vars?: MessageVars) => t(lang, key, vars);
  if (!entries.length) return { content: tr('stock.list.empty'), components: [] };
  const pages = Math.ceil(entries.length / PAGE_SIZE);
  const current = Math.min(Math.max(page, 0), pages - 1);
  // Totals per material over the whole list (not just this page), exact in millionths
  const totals = new Map<string, bigint>();
  for (const p of entries) totals.set(p.material, (totals.get(p.material) ?? 0n) + toMicros(p.batch.quantity));
  const lines = [tr(org ? 'stock.list.org' : 'stock.list.personal', { count: entries.length })];
  let lastMaterial: string | null = null;
  for (const p of entries.slice(current * PAGE_SIZE, (current + 1) * PAGE_SIZE)) {
    // The material header repeats on every page, so each page reads on its own
    if (p.material !== lastMaterial) {
      const total = amountText(lang, formatMicros(totals.get(p.material)!), p.batch.kind);
      lines.push(`__${escapeMarkdown(p.material)}__ · ${tr('stock.list.total', { amount: total })}`);
    }
    lastMaterial = p.material;
    const parts = [
      `${p.batch.state === 'refining' ? '⚗️ ' : ''}Q${p.batch.quality}`,
      amountText(lang, p.batch.quantity, p.batch.kind),
      escapeMarkdown(p.location),
      org ? escapeMarkdown(p.holderName ?? '?') : null,
    ];
    lines.push(`- ${parts.filter(Boolean).join(' · ')}`);
  }
  if (pages > 1) lines.push(`-# ${tr('list.page', { page: current + 1, pages })}`);
  const components = pages > 1 ? [new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`${NAME}:list:${token}:${current - 1}`).setLabel('◀').setStyle(ButtonStyle.Secondary).setDisabled(current === 0),
    new ButtonBuilder().setCustomId(`${NAME}:list:${token}:${current + 1}`).setLabel('▶').setStyle(ButtonStyle.Secondary).setDisabled(current === pages - 1),
  )] : [];
  return { content: lines.join('\n'), components, allowedMentions: { parse: [] } };
}

// --- input -----------------------------------------------------------------------------------

/** Material option value `<kind>:<uuid>` (from the suggestions). */
function pickedMaterial(ctx: CommandContext, name = 'material') {
  const value = ctx.interaction.options.getString(name);
  if (value === null) return null;
  const m = /^(resource|item):(.+)$/.exec(value);
  if (!m) throw new UserError('stock.err.unknownSubject');
  return { kind: m[1] as 'resource' | 'item', uuid: m[2]! };
}

async function pickedLocation(ctx: CommandContext, name: string): Promise<string | undefined> {
  const value = ctx.interaction.options.getString(name) ?? undefined;
  if (value !== undefined && !(await locationCatalog(ctx.db, ctx.lang)).has(value)) throw new UserError('stock.err.unknownLocation');
  return value;
}

/** Holder option: an active member of the org (user ID from the suggestions); also returns the display name. */
async function pickedHolder(ctx: CommandContext, guildId: string) {
  const value = ctx.interaction.options.getString('holder');
  if (value === null) return null;
  const entry = /^\d{17,20}$/.test(value) ? await rosterEntry(ctx.db, guildId, value) : null;
  if (!entry?.active) throw new UserError('stock.err.holderNotMember');
  return { userId: value, name: entry.displayName };
}

function checkAmount(text: string | null, kind: 'resource' | 'item', allowZero = false): string | null {
  if (text === null) return null;
  if (allowZero && /^\s*0+(?:[.,]0+)?\s*$/.test(text)) return '0';
  const parsed = parseAmount(text, kind);
  if (!parsed) throw new UserError('stock.err.invalidAmount');
  return parsed;
}

// --- autocomplete ----------------------------------------------------------------------------

async function autocomplete(interaction: AutocompleteInteraction, lang: Lang, db: Db) {
  // No roster writes here (autocomplete must answer fast); non-members just get no suggestions
  const settings = interaction.inGuild() ? await findGuildSettings(db, interaction.guildId) : null;
  const access = settings && interaction.member ? accessOf(memberInfo(interaction.member).roleIds, settings) : null;
  if (!access?.member) return interaction.respond([]);
  const actor: stock.Actor = { userId: interaction.user.id, guildId: interaction.guildId!, officer: access.officer, source: 'bot' };
  const focused = interaction.options.getFocused(true);
  const query = String(focused.value);
  const sub = interaction.options.getSubcommand();
  let choices: Choice[] = [];
  if (focused.name === 'material') choices = await materialChoices(db, lang, query, false);
  else if (focused.name === 'location') choices = await locationChoices(db, lang, query);
  else if (focused.name === 'batch') choices = await batchChoices(db, actor, sub === 'move' ? 'move' : 'change', lang, query);
  else if (focused.name === 'holder') {
    choices = (await searchMembers(db, actor.guildId!, query)).map((m) => ({
      name: (m.rsiHandle ? `${m.displayName} · ${m.rsiHandle}` : m.displayName).slice(0, 100), value: m.userId,
    }));
  }
  await interaction.respond(choices);
}

// --- command ---------------------------------------------------------------------------------

export const stockCommand: BotCommand = {
  data: {
    name: NAME,
    ...localizedDescription('cmd.stock'),
    contexts: [InteractionContextType.Guild],
    integration_types: [ApplicationIntegrationType.GuildInstall],
    options: [
      opt('add', 'cmd.stock.add', ApplicationCommandOptionType.Subcommand, {
        options: [
          opt('material', 'opt.material', S, { required: true, ...auto }),
          opt('amount', 'opt.amount', S, { required: true }),
          opt('quality', 'opt.quality', ApplicationCommandOptionType.Integer, { required: true, min_value: 0, max_value: 1000 }),
          opt('location', 'opt.location', S, { required: true, ...auto }),
          opt('org', 'opt.org', ApplicationCommandOptionType.Boolean),
          opt('holder', 'opt.holder', S, auto),
        ],
      }),
      opt('remove', 'cmd.stock.remove', ApplicationCommandOptionType.Subcommand, {
        options: [opt('batch', 'opt.batch', S, { required: true, ...auto }), opt('amount', 'opt.amountOrAll', S)],
      }),
      opt('move', 'cmd.stock.move', ApplicationCommandOptionType.Subcommand, {
        options: [
          opt('batch', 'opt.batch', S, { required: true, ...auto }),
          opt('amount', 'opt.amountOrAll', S),
          opt('location', 'opt.toLocation', S, auto),
          opt('org', 'opt.toOrg', ApplicationCommandOptionType.Boolean),
          opt('holder', 'opt.holder', S, auto),
        ],
      }),
      opt('adjust', 'cmd.stock.adjust', ApplicationCommandOptionType.Subcommand, {
        options: [opt('batch', 'opt.batch', S, { required: true, ...auto }), opt('amount', 'opt.amountCounted', S, { required: true })],
      }),
      opt('list', 'cmd.stock.list', ApplicationCommandOptionType.Subcommand, {
        options: [
          opt('org', 'opt.listOrg', ApplicationCommandOptionType.Boolean),
          opt('material', 'opt.onlyMaterial', S, auto),
          opt('location', 'opt.onlyLocation', S, auto),
          opt('holder', 'opt.onlyHolder', S, auto),
        ],
      }),
      opt('find', 'cmd.stock.find', ApplicationCommandOptionType.Subcommand, {
        options: [
          opt('material', 'opt.material', S, { required: true, ...auto }),
          opt('min_quality', 'opt.minQuality', ApplicationCommandOptionType.Integer, { min_value: 0, max_value: 1000 }),
        ],
      }),
    ],
  },
  execute: bySubcommand({
    async add(ctx) {
      const access = await requireMember(ctx.db, ctx.interaction);
      const o = ctx.interaction.options;
      const material = pickedMaterial(ctx)!;
      const holder = await pickedHolder(ctx, access.guildId);
      const r = await book(() => stock.add(ctx.db, actorOf(access), {
        ...material,
        locationUuid: o.getString('location', true),
        quality: o.getInteger('quality', true),
        amount: o.getString('amount', true),
        // Naming a holder only makes sense for org stock
        org: (o.getBoolean('org') ?? false) || holder !== null,
        holderUserId: holder?.userId,
      }));
      const amount = amountText(ctx.lang, r.journal[0]!.delta, r.batch!.kind);
      const content = ctx.t('stock.added', { amount, what: what(await describe(ctx.db, r.batch!, ctx.lang), ctx.lang, true) })
        + await totalSuffix(ctx.db, ctx.lang, r.batch!);
      await ctx.reply({ content, allowedMentions: { parse: [] } });
    },
    async remove(ctx) {
      const access = await requireMember(ctx.db, ctx.interaction);
      const p = await pickedBatch(ctx, actorOf(access), 'change');
      const amount = checkAmount(ctx.interaction.options.getString('amount'), p.batch.kind);
      const shown = amountText(ctx.lang, amount ?? p.batch.quantity, p.batch.kind);
      await askConfirmation(ctx, access.userId, { op: 'remove', batchId: p.batch.id, amount, expected: p.batch.quantity },
        ctx.t(amount === null ? 'stock.confirm.removeAll' : 'stock.confirm.remove', { amount: shown, what: what(p, ctx.lang) }));
    },
    async move(ctx) {
      const access = await requireMember(ctx.db, ctx.interaction);
      const o = ctx.interaction.options;
      const p = await pickedBatch(ctx, actorOf(access), 'move');
      const amount = checkAmount(o.getString('amount'), p.batch.kind);
      const toLocationUuid = await pickedLocation(ctx, 'location');
      const toOrg = o.getBoolean('org') ?? undefined;
      const holder = await pickedHolder(ctx, access.guildId);
      if (toLocationUuid === undefined && toOrg === undefined && holder === null) throw new UserError('stock.err.nothingToMove');
      // What the target will look like (the service decides and checks the same way when booking)
      const targetOrg = toOrg ?? p.batch.designation === 'org';
      const location = toLocationUuid ? (await locationCatalog(ctx.db, ctx.lang)).get(toLocationUuid)!.short : p.location;
      const holderName = holder?.name ?? (p.batch.designation === 'org' ? p.holderName : (await rosterEntry(ctx.db, access.guildId, access.userId))?.displayName);
      const target = `${escapeMarkdown(location)} · ${targetOrg ? `${ctx.t('stock.org')} (${escapeMarkdown(holderName ?? '?')})` : ctx.t('stock.personal')}`;
      await askConfirmation(ctx, access.userId, {
        op: 'move', batchId: p.batch.id, amount, expected: p.batch.quantity, toLocationUuid, toOrg, toHolderUserId: holder?.userId,
      }, ctx.t('stock.confirm.move', { amount: amountText(ctx.lang, amount ?? p.batch.quantity, p.batch.kind), what: what(p, ctx.lang), target }));
    },
    async adjust(ctx) {
      const access = await requireMember(ctx.db, ctx.interaction);
      const p = await pickedBatch(ctx, actorOf(access), 'change');
      const amount = checkAmount(ctx.interaction.options.getString('amount', true), p.batch.kind, true)!;
      await askConfirmation(ctx, access.userId, { op: 'adjust', batchId: p.batch.id, amount, expected: p.batch.quantity },
        ctx.t('stock.confirm.adjust', { amount: amountText(ctx.lang, amount, p.batch.kind), what: what(p, ctx.lang) }));
    },
    async list(ctx) {
      const access = await requireMember(ctx.db, ctx.interaction);
      const holder = await pickedHolder(ctx, access.guildId);
      // Filtering by holder only makes sense for org stock: others' personal stock is private
      const org = (ctx.interaction.options.getBoolean('org') ?? false) || holder !== null;
      const query: ListQuery = {
        org,
        filter: {
          scope: org ? { guildId: access.guildId } : { personalOf: access.userId },
          subjectUuid: pickedMaterial(ctx)?.uuid,
          locationUuid: await pickedLocation(ctx, 'location'),
          holderUserId: holder?.userId,
        },
      };
      const token = putState(access.userId, query, LIST_TTL_MS);
      await ctx.reply(listPage(await stockList(ctx.db, query.filter, ctx.lang), org, 0, ctx.lang, token));
    },
    async find(ctx) {
      const access = await requireMember(ctx.db, ctx.interaction);
      const material = pickedMaterial(ctx)!;
      const min = ctx.interaction.options.getInteger('min_quality') ?? 0;
      const found = await findStock(ctx.db, access.guildId, access.userId, material.uuid, min, ctx.lang);
      const name = escapeMarkdown((await materialCatalog(ctx.db, ctx.lang)).get(material.uuid)?.name ?? '?');
      const minText = min > 0 ? ctx.t('stock.find.min', { min }) : '';
      if (!found.length) return ctx.reply(ctx.t('stock.find.none', { material: name, min: minText }));
      const lines = found.slice(0, MAX_FIND).map((p) => `- ${[
        `Q${p.batch.quality}`,
        amountText(ctx.lang, p.batch.quantity, p.batch.kind),
        escapeMarkdown(p.location),
        p.batch.designation === 'org' ? `${ctx.t('stock.org')} (${escapeMarkdown(p.holderName ?? '?')})` : ctx.t('stock.personal'),
      ].join(' · ')}`);
      if (found.length > MAX_FIND) lines.push(ctx.t('bp.who.more', { count: found.length - MAX_FIND }));
      await ctx.reply({
        content: [ctx.t('stock.find.title', { material: name, min: minText, count: found.length }), ...lines].join('\n'),
        allowedMentions: { parse: [] },
      });
    },
  }),
  autocomplete,
  async component(ctx) {
    const [, action, token, page] = ctx.interaction.customId.split(':');
    if ((action === 'confirm' || action === 'cancel') && token) return onConfirmButton(ctx.interaction, ctx.db, ctx.lang, action, token);
    if (action !== 'list' || !token) throw new Error(`Unexpected component ${ctx.interaction.customId}`);
    const state = getState<ListQuery>(token, ctx.interaction.user.id);
    if (!state.ok && state.reason === 'foreign') throw new UserError('stock.foreign');
    if (!state.ok) {
      await ctx.interaction.update({ content: t(ctx.lang, 'list.expired'), components: [] });
      return;
    }
    await requireMember(ctx.db, ctx.interaction);
    const entries = await stockList(ctx.db, state.value.filter, ctx.lang);
    await ctx.interaction.update(listPage(entries, state.value.org, Number(page) || 0, ctx.lang, token));
  },
};
