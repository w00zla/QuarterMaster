// /qm-res and /qm-gear: options pick what to book (autocomplete), a modal asks for the rest (amount,
// quality or a component's stats, orgs), lists and searches answer as panels. Submitting a modal books right
// away: the modal shows the batch and the amount, like the web app's dialogs. The two commands work on the
// same stock like the web app's tabs: /qm-res the materials and items, /qm-gear the ship components.
import {
  ActionRowBuilder, ApplicationCommandOptionType, ApplicationIntegrationType, ButtonBuilder, ButtonStyle, CheckboxGroupBuilder,
  CheckboxGroupOptionBuilder, ContainerBuilder, InteractionContextType, LabelBuilder, MessageFlags, ModalBuilder, SeparatorBuilder,
  TextDisplayBuilder,
  type APIApplicationCommandOption, type AutocompleteInteraction, type ModalSubmitInteraction,
} from 'discord.js';
import type { Db } from '../../db/client.ts';
import { formatMicros, toMicros } from '../../planner/plan.ts';
import { formatAmount, parseAmount } from '../../stock/amount.ts';
import { statBest, statsText, statValue, statValueText } from '../../stock/component-stats.ts';
import {
  activeOrgs, findStock, locationCatalog, materialCatalog, materialTotal, orgNames, pickableBatches, stockList,
  type BatchPick, type ComponentStat, type MaterialEntry, type OrgName, type PickableBatch, type StockFilter,
} from '../../stock/lookup.ts';
import * as stock from '../../stock/service.ts';
import { requireMember } from '../access.ts';
import { rosterEntry } from '../blueprints.ts';
import { UserError } from '../errors.ts';
import { localizedDescription, t, type Lang, type MessageKey, type MessageVars } from '../i18n.ts';
import { batchChoices, locationChoices, materialChoices, type Choice } from '../pickers.ts';
import { bySubcommand, type BotCommand, type CommandContext } from '../registry.ts';
import { accessOf, memberInfo, searchMembers } from '../roster.ts';
import { findGuildSettings } from '../settings.ts';
import { escapeMarkdown } from '../markdown.ts';
import { addHead, thumbSection, thumbUrl } from '../thumbs.ts';
import { customId, panel, textField, textValue, webAppButton, webAppPath } from '../ui.ts';

const PAGE_SIZE = 20;
const MAX_FIND = 25;
// Discord's limit for the options of a checkbox group
const MAX_ORG_OPTIONS = 10;

/** Which command: its name, its texts (`cmd.<key>.*`), the option that picks what it books, ship components or not. */
interface Area {
  name: 'qm-res' | 'qm-gear';
  key: 'stock' | 'comps';
  option: 'material' | 'component';
  components: boolean;
}

const STOCK: Area = { name: 'qm-res', key: 'stock', option: 'material', components: false };
const COMPS: Area = { name: 'qm-gear', key: 'comps', option: 'component', components: true };

// Option JSON with a localized description; Discord validates the shape on registration
const opt = (name: string, key: MessageKey, type: ApplicationCommandOptionType, extra: Record<string, unknown> = {}) =>
  ({ name, ...localizedDescription(key), type, ...extra }) as APIApplicationCommandOption;
const S = ApplicationCommandOptionType.String;
const auto = { autocomplete: true };

const actorOf = (a: { userId: string; guildId: string }): stock.Actor => ({ userId: a.userId, guildId: a.guildId, source: 'bot' });

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

/** A batch as the bot shows it: a component under its unique label with its stats as text ("" without any). */
export type ShownBatch = PickableBatch & { statsText?: string };

/** Components named by their unique label, with their stats (retired ones keep their name). */
function named(list: PickableBatch[], materials: Map<string, MaterialEntry>): ShownBatch[] {
  return list.map((p) => {
    if (!p.component) return p;
    const m = materials.get(p.batch.itemUuid!);
    return { ...p, material: m?.label ?? p.material, statsText: statsText(m?.stats ?? [], p.batch.stats) };
  });
}

/** A batch as it looks now (names from the catalog caches, shares from the database). */
async function describe(db: Db, actor: stock.Actor, batchId: number, lang: Lang): Promise<ShownBatch | undefined> {
  const found = (await pickableBatches(db, actor, 'change', lang)).filter((p) => p.batch.id === batchId);
  return named(found, await materialCatalog(db, lang))[0];
}

// A booking's reply: line 1 what happened ("📥 Booked **2 SCU** · **Metal** Q900"), line 2 the batch as it
// is now (place · shares, its amount only where it differs from what was booked), line 3 small: the
// material in your stock (only where that is more than this batch). Nothing said twice.

/** "**Metal** Q900", a component "**Name · Cooler · S2 · B Military** · Integrity +5.0 %": what a booking was about. */
const subject = (p: Pick<ShownBatch, 'material' | 'component' | 'statsText'> & { batch: Pick<stock.Batch, 'quality'> }) =>
  (p.component ? [`**${escapeMarkdown(p.material)}**`, p.statsText && escapeMarkdown(p.statsText)].filter(Boolean).join(' · ')
    : `**${escapeMarkdown(p.material)}** Q${p.batch.quality}`);

const same = (a: string, b: string) => formatAmount(a) === formatAmount(b);

/** "12 SCU · Area18 · shared in Org A, Org B" (or "· personal"). */
async function batchNow(db: Db, p: PickableBatch, lang: Lang, { amount = true, shares = true } = {}): Promise<string> {
  const parts = [...(amount ? [amountText(lang, p.batch.quantity, p.batch.kind)] : []), escapeMarkdown(p.location)];
  if (shares) {
    const orgs = (await orgNames(db, p.sharedIn)).map((o) => escapeMarkdown(o.name));
    parts.push(orgs.length ? t(lang, 'stock.result.sharedIn', { orgs: orgs.join(', ') }) : t(lang, 'stock.result.personal'));
  }
  return parts.join(' · ');
}

/** A modal's head: the batch as in a result ("**Metal** Q900", then "12 SCU · Area18 · personal"). */
async function batchHead(db: Db, p: ShownBatch, lang: Lang, withShares = true): Promise<string> {
  return `${subject(p)}\n${await batchNow(db, p, lang, { shares: withShares })}`;
}

/** Line 2: "Area18 · shared in Org A" when the batch holds just what was booked, else "Batch: 14.5 SCU · Area18 · …". */
async function batchLine(db: Db, p: PickableBatch, lang: Lang, booked?: string): Promise<string> {
  if (booked !== undefined && same(p.batch.quantity, booked)) return batchNow(db, p, lang, { amount: false });
  return t(lang, 'stock.result.batch', { batch: await batchNow(db, p, lang) });
}

/** "-# Metal in your stock: 30 SCU" after the booking; null when that is just the batch (`batchAmount`). */
async function totalLine(db: Db, lang: Lang, material: string, b: Pick<stock.Batch, 'ownerUserId' | 'resourceUuid' | 'itemUuid' | 'kind'>,
  batchAmount: string): Promise<string | null> {
  const total = await materialTotal(db, { personalOf: b.ownerUserId }, b.resourceUuid ?? b.itemUuid!);
  if (same(total, batchAmount)) return null;
  return `-# ${t(lang, 'stock.result.total', { material: escapeMarkdown(material), amount: amountText(lang, total, b.kind) })}`;
}

const lines = (...parts: (string | null)[]) => parts.filter((x): x is string => x !== null).join('\n');

// --- bookings (no Discord objects: tested on their own) ---------------------------------------

export interface AddBooking {
  kind: 'resource' | 'item';
  uuid: string;
  locationUuid: string;
  quality: number;
  // As typed
  amount: string;
  // The orgs ticked in the modal
  shareIn: string[];
  // Ship components: {crafted property UUID: value} as parsed from the modal
  stats?: Record<string, string>;
}

/**
 * Books new stock and shares the batch it lands in with the ticked orgs on top of its shares (an
 * existing batch keeps the orgs it is shared in). The text for the reply.
 */
export async function bookAdd(db: Db, actor: stock.Actor, input: AddBooking, lang: Lang): Promise<string> {
  const { shareIn, ...add } = input;
  const r = await book(() => stock.add(db, actor, add));
  const before = await describe(db, actor, r.batch!.id, lang);
  const wanted = [...new Set([...(before?.sharedIn ?? []), ...shareIn])];
  let note = '';
  if (wanted.length > (before?.sharedIn.length ?? 0)) {
    try {
      await stock.share(db, actor, { batchId: r.batch!.id, guildIds: wanted });
    } catch (err) {
      // The stock is booked; only the sharing failed (e.g. no longer a member of a ticked org)
      if (!(err instanceof stock.StockError)) throw err;
      note = `\n${t(lang, 'stock.shareFailed', { reason: t(lang, `stock.err.${err.code}`) })}`;
    }
  }
  const after = (await describe(db, actor, r.batch!.id, lang))!;
  const booked = r.journal[0]!.delta;
  return lines(
    t(lang, 'stock.added', { amount: amountText(lang, booked, r.batch!.kind), what: subject(after) }),
    await batchLine(db, after, lang, booked),
    await totalLine(db, lang, after.material, r.batch!, after.batch.quantity),
  ) + note;
}

/** A change of one batch as submitted in its modal; `expected` = the amount the modal showed. */
export type Change =
  | { op: 'remove'; batchId: number; amount: string; expected: string }
  // `stats`: a component's whole new set of stats (omitted = unchanged)
  | { op: 'adjust'; batchId: number; amount: string; expected: string; stats?: Record<string, string> }
  | { op: 'move'; batchId: number; amount: string; expected: string; toLocationUuid: string }
  | { op: 'give'; batchId: number; amount: string; expected: string; toOwnerUserId: string; toOwnerName: string };

/** Books a change with the rights the user has now; the text for the reply. */
export async function bookChange(db: Db, actor: stock.Actor, c: Change, lang: Lang): Promise<string> {
  if (c.op === 'remove') {
    const before = await describe(db, actor, c.batchId, lang);
    const r = await book(() => stock.remove(db, actor, { batchId: c.batchId, amount: c.amount, expected: c.expected }));
    const j = r.journal[0]!;
    const removed = amountText(lang, j.delta.replace(/^-/, ''), j.kind);
    const after = await batchAfter(db, actor, r.batch, before, lang);
    return lines(
      t(lang, 'stock.removed', { amount: removed, what: before ? subject(before) : '?' }),
      after.line,
      await totalLine(db, lang, before?.material ?? '?', j, after.amount),
    );
  }
  if (c.op === 'adjust') {
    const before = await describe(db, actor, c.batchId, lang);
    const r = await book(() => stock.adjust(db, actor, {
      batchId: c.batchId, amount: c.amount, expected: c.expected, ...(c.stats ? { stats: c.stats } : {}),
    }));
    const after = await batchAfter(db, actor, r.batch, before, lang);
    // Other stats moved the batch: what it is now, with its amount in line 2
    if (r.journal.some((j) => j.action === 'move_in') && after.left) {
      return lines(
        t(lang, 'stock.restated', { what: subject(after.left) }),
        await batchLine(db, after.left, lang),
        await totalLine(db, lang, after.left.material, after.left.batch, after.amount),
      );
    }
    const j = r.journal[0]!;
    const delta = `${j.delta.startsWith('-') ? '' : '+'}${amountText(lang, j.delta, j.kind)}`;
    return lines(
      t(lang, 'stock.adjusted', { delta, what: before ? subject(before) : '?' }),
      after.line,
      await totalLine(db, lang, before?.material ?? '?', j, after.amount),
    );
  }
  const r = await book(() => stock.move(db, actor, {
    batchId: c.batchId, amount: c.amount, expected: c.expected,
    ...(c.op === 'move' ? { toLocationUuid: c.toLocationUuid } : { toOwnerUserId: c.toOwnerUserId }),
  }));
  const j = r.journal[1]!;
  if (c.op === 'give') {
    // The batch is the recipient's now: described from the catalogs, no total (their stock is private)
    const [materials, locations] = [await materialCatalog(db, lang), await locationCatalog(db, lang)];
    const b = r.batch!;
    const m = materials.get(b.resourceUuid ?? b.itemUuid!);
    const what = subject({ material: (m?.component ? m.label : m?.name) ?? '?', component: !!m?.component, statsText: statsText(m?.stats ?? [], b.stats), batch: b });
    return [
      t(lang, 'stock.given', { amount: amountText(lang, j.delta, j.kind), what }),
      t(lang, 'stock.result.to', { name: escapeMarkdown(c.toOwnerName), location: escapeMarkdown(locations.get(b.locationUuid)?.short ?? '?') }),
    ].join('\n');
  }
  const moved = (await describe(db, actor, r.batch!.id, lang))!;
  return lines(
    t(lang, 'stock.moved', { amount: amountText(lang, j.delta, j.kind), what: subject(moved) }),
    await batchLine(db, moved, lang, j.delta),
    await totalLine(db, lang, moved.material, r.batch!, moved.batch.quantity),
  );
}

/** Line 2 after a remove or correction: what is left of the batch (its amount is news), or "empty" and where it was. */
async function batchAfter(db: Db, actor: stock.Actor, batch: stock.Batch | null, before: PickableBatch | undefined, lang: Lang) {
  const left = batch ? await describe(db, actor, batch.id, lang) : undefined;
  if (left) return { line: await batchLine(db, left, lang), amount: left.batch.quantity, left };
  return { line: t(lang, 'stock.result.empty', { location: escapeMarkdown(before?.location ?? '?') }), amount: '0', left };
}

/** Sets the orgs a batch is shared in; the text for the reply. */
export async function bookShare(db: Db, actor: stock.Actor, batchId: number, guildIds: string[], lang: Lang): Promise<string> {
  const r = await book(() => stock.share(db, actor, { batchId, guildIds })).catch((err: unknown) => {
    // "No change" here means the same orgs were submitted again, not an amount
    throw err instanceof UserError && err.key === 'stock.err.noChange' ? new UserError('stock.err.shareNoChange') : err;
  });
  const p = (await describe(db, actor, r.batch.id, lang))!;
  const batch = `${subject(p)} · ${amountText(lang, p.batch.quantity, p.batch.kind)} · ${escapeMarkdown(p.location)}`;
  if (!r.guildIds.length) return [t(lang, 'stock.unshared'), batch].join('\n');
  const names = (await orgNames(db, r.guildIds)).map((o) => escapeMarkdown(o.name));
  return [t(lang, 'stock.sharedIn', { orgs: names.join(', ') }), batch].join('\n');
}

// --- a component's stats in a modal --------------------------------------------------------------

// "Coolant Rating (max. +20.0 %)", "Recoil Kick (max. −40.0 %)": a line's fixed part
const statHead = (s: ComponentStat) => `${s.name} (max. ${statValueText(s.kind, String(statBest(s)))})`;

/** The stats field: one line per stat the component can carry, "Coolant Rating (max. +20.0 %): 5" (0 = no change). */
export function statLines(stats: ComponentStat[], current: Record<string, string> | null): string {
  return stats.map((s) => `${statHead(s)}: ${current?.[s.uuid] ?? '0'}`).join('\n');
}

/**
 * The stats as typed in the field statLines filled: the number after each colon ("%" and "+" allowed), an
 * empty field = none. Lines that were changed beyond their number, or values out of bounds, are refused.
 */
export function parseStatLines(text: string, stats: ComponentStat[]): Record<string, string> {
  const rows = text.split('\n').map((l) => l.trim()).filter(Boolean);
  if (!rows.length) return {};
  if (rows.length !== stats.length) throw new UserError('stock.err.statLines');
  const parsed: Record<string, string> = {};
  stats.forEach((s, i) => {
    const row = rows[i]!;
    const colon = row.lastIndexOf(':');
    if (colon < 0 || row.slice(0, colon).trim() !== statHead(s)) throw new UserError('stock.err.statLine', { line: i + 1 });
    const value = statValue(s, row.slice(colon + 1).replace('%', '').trim());
    if (value === null) throw new UserError('stock.err.statValue', { line: i + 1, min: s.min, max: `${s.max}${s.kind === 'multiplier' ? ' %' : ''}` });
    if (value !== '0') parsed[s.uuid] = value;
  });
  return parsed;
}

const statsField = (lang: Lang, stats: ComponentStat[], current: Record<string, string> | null) =>
  textField('stats', t(lang, 'stock.field.stats'), {
    value: statLines(stats, current), description: t(lang, 'stock.field.statsHint'), paragraph: true, required: false, maxLength: 1000,
  });

// --- panels ----------------------------------------------------------------------------------

/** Which stock a list shows: p = personal (everything you own), o = shared in this org, a = both. */
export type ListScope = 'p' | 'o' | 'a';

export interface ListView {
  scope: ListScope;
  page: number;
  // Only this material (UUID)
  material: string | null;
}

const listId = (area: Area, v: ListView) => customId(area.name, 'list', v.scope, v.page, v.material ?? '-');

function parseListId(parts: string[]): ListView {
  const [scope, page, material] = parts;
  if (scope !== 'p' && scope !== 'o' && scope !== 'a') throw new Error(`Unexpected list scope ${scope}`);
  return { scope, page: Number(page) || 0, material: material && material !== '-' ? material : null };
}

/**
 * The lines of one list page, grouped by material with each material's total over the whole list. The owner
 * column: the org list names who shares it, "All" marks your own "Pers.", your own list marks what you share.
 * Components show their stats where materials show their quality.
 */
export function listLines(entries: ShownBatch[], scope: ListScope, userId: string, page: number, lang: Lang) {
  const tr = (key: MessageKey, vars?: MessageVars) => t(lang, key, vars);
  const pages = Math.max(1, Math.ceil(entries.length / PAGE_SIZE));
  const current = Math.min(Math.max(page, 0), pages - 1);
  const totals = new Map<string, bigint>();
  for (const p of entries) totals.set(p.material, (totals.get(p.material) ?? 0n) + toMicros(p.batch.quantity));
  const lines: string[] = [];
  let lastMaterial: string | null = null;
  for (const p of entries.slice(current * PAGE_SIZE, (current + 1) * PAGE_SIZE)) {
    // The material header repeats on every page, so each page reads on its own
    if (p.material !== lastMaterial) {
      const total = amountText(lang, formatMicros(totals.get(p.material)!), p.batch.kind);
      lines.push(`__${escapeMarkdown(p.material)}__ · ${tr('stock.list.total', { amount: total })}`);
    }
    lastMaterial = p.material;
    const owner = scope === 'o' ? escapeMarkdown(p.holderName ?? '?')
      : scope === 'a' ? (p.batch.ownerUserId === userId ? tr('stock.personal') : escapeMarkdown(p.holderName ?? '?'))
      : p.sharedIn.length ? tr('stock.shared') : null;
    const parts = [
      p.component ? escapeMarkdown(p.statsText ?? '') : `${p.batch.state === 'refining' ? '⚗️ ' : ''}Q${p.batch.quality}`,
      amountText(lang, p.batch.quantity, p.batch.kind),
      escapeMarkdown(p.location),
      owner,
    ];
    lines.push(`- ${parts.filter(Boolean).join(' · ')}`);
  }
  return { lines, page: current, pages };
}

// The web app's stock (or components) view in a scope: personal, all or a guild ID
const linkRow = (area: Area, lang: Lang, scope: string, ...buttons: ButtonBuilder[]) => {
  const link = webAppButton(lang, area.components ? webAppPath.components(scope) : webAppPath.stock(scope));
  const all = link ? [...buttons, link] : buttons;
  return all.length ? new ActionRowBuilder<ButtonBuilder>().addComponents(all) : null;
};

/** The list panel: scope buttons, one page of lines, paging and the web app link. */
async function listPanel(area: Area, db: Db, actor: { userId: string; guildId: string }, view: ListView, lang: Lang) {
  const tr = (key: MessageKey, vars?: MessageVars) => t(lang, key, vars);
  const scope: StockFilter['scope'] = view.scope === 'p' ? { personalOf: actor.userId }
    : view.scope === 'o' ? { guildId: actor.guildId } : { allOf: actor.userId };
  const found = (await stockList(db, { scope, subjectUuid: view.material ?? undefined }, lang)).filter((p) => p.component === area.components);
  // Sorted again: components go by their label
  const entries = named(found, await materialCatalog(db, lang))
    .sort((a, b) => a.material.localeCompare(b.material) || b.batch.quality - a.batch.quality || a.batch.id - b.batch.id);
  const orgName = (await orgNames(db, [actor.guildId]))[0]?.name ?? tr('stock.org');
  const scopeName = view.scope === 'p' ? tr('stock.scope.personal') : view.scope === 'o' ? orgName : tr('stock.scope.all');
  const { lines, page, pages } = listLines(entries, view.scope, actor.userId, view.page, lang);

  const scopeButton = (scope: ListScope, label: string) => new ButtonBuilder()
    .setCustomId(listId(area, { ...view, scope, page: 0 })).setLabel(label.slice(0, 80))
    .setStyle(scope === view.scope ? ButtonStyle.Primary : ButtonStyle.Secondary);
  const title = tr(area.components ? 'comps.list.title' : 'stock.list.title', { scope: escapeMarkdown(scopeName), count: entries.length });
  const container = new ContainerBuilder()
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(title))
    .addActionRowComponents(new ActionRowBuilder<ButtonBuilder>().addComponents(
      scopeButton('p', tr('stock.scope.personal')), scopeButton('o', orgName), scopeButton('a', tr('stock.scope.all')),
    ))
    .addSeparatorComponents(new SeparatorBuilder())
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(lines.length ? lines.join('\n') : tr('stock.list.empty')));
  const paging = pages > 1 ? [
    new ButtonBuilder().setCustomId(listId(area, { ...view, page: page - 1 })).setLabel('◀').setStyle(ButtonStyle.Secondary).setDisabled(page === 0),
    new ButtonBuilder().setCustomId(listId(area, { ...view, page: page + 1 })).setLabel('▶').setStyle(ButtonStyle.Secondary).setDisabled(page === pages - 1),
  ] : [];
  if (pages > 1) container.addTextDisplayComponents(new TextDisplayBuilder().setContent(`-# ${tr('list.page', { page: page + 1, pages })}`));
  const row = linkRow(area, lang, view.scope === 'p' ? 'personal' : view.scope === 'o' ? actor.guildId : 'all', ...paging);
  if (row) container.addActionRowComponents(row);
  return panel(container);
}

/**
 * The reply after a booking: what happened, a button to the list and the web app link. With a thumbnail of the
 * batch's material or item (`uuid`) a Components V2 message: the text beside it, the buttons below.
 */
function bookedReply(area: Area, text: string, lang: Lang, uuid?: string | null) {
  const mine = new ButtonBuilder().setCustomId(customId(area.name, 'mine'))
    .setLabel(t(lang, area.components ? 'comps.btn.yours' : 'stock.btn.yourStock')).setStyle(ButtonStyle.Secondary);
  const row = linkRow(area, lang, 'personal', mine)!;
  const thumb = thumbUrl(uuid);
  if (thumb) return { components: [thumbSection(text, thumb), row], flags: MessageFlags.IsComponentsV2 as number, allowedMentions: { parse: [] } };
  return { content: text, components: [row], allowedMentions: { parse: [] } };
}

// --- input -----------------------------------------------------------------------------------

/** The material (or component) option, value `<kind>:<uuid>` (from the suggestions), checked against the catalog. */
async function pickedMaterial(area: Area, ctx: CommandContext, required: boolean) {
  const value = ctx.interaction.options.getString(area.option, required);
  if (value === null) return null;
  const m = /^(resource|item):(.+)$/.exec(value);
  const entry = m ? (await materialCatalog(ctx.db, ctx.lang)).get(m[2]!) : undefined;
  if (!entry || entry.component !== area.components) throw new UserError(area.components ? 'comps.err.unknown' : 'stock.err.unknownSubject');
  return { kind: m![1] as 'resource' | 'item', uuid: m![2]!, entry };
}

async function pickedLocation(ctx: CommandContext, name: string) {
  const uuid = ctx.interaction.options.getString(name, true);
  const entry = (await locationCatalog(ctx.db, ctx.lang)).get(uuid);
  if (!entry) throw new UserError('stock.err.unknownLocation');
  return entry;
}

/** The batch option: one the actor may change (also checks that it exists, is theirs and belongs to this command). */
async function pickedBatch(area: Area, ctx: CommandContext, actor: stock.Actor, pick: BatchPick): Promise<ShownBatch> {
  const id = Number(ctx.interaction.options.getString('batch', true));
  const found = Number.isInteger(id) ? (await pickableBatches(ctx.db, actor, pick, ctx.lang)).filter((p) => p.batch.id === id) : [];
  const p = named(found, await materialCatalog(ctx.db, ctx.lang))[0];
  if (!p || p.component !== area.components) throw new UserError('stock.err.batchNotFound');
  return p;
}

function checkAmount(text: string, kind: 'resource' | 'item', allowZero = false): string {
  if (allowZero && /^\s*0+(?:[.,]0+)?\s*$/.test(text)) return '0';
  const parsed = parseAmount(text, kind);
  if (!parsed) throw new UserError('stock.err.invalidAmount');
  return parsed;
}

/** Quality 0–1000 as typed. */
export function parseQuality(text: string): number | null {
  const s = text.trim();
  if (!/^\d{1,4}$/.test(s)) return null;
  const n = Number(s);
  return n <= 1000 ? n : null;
}

// --- modals ----------------------------------------------------------------------------------

const info = (text: string) => new TextDisplayBuilder().setContent(text);

const amountField = (lang: Lang, kind: string, value: string, key: MessageKey = 'stock.field.amount', hint: MessageKey = 'stock.field.amountHint') =>
  textField('amount', t(lang, key, { unit: unit(lang, kind) }), { value: formatAmount(value), description: t(lang, hint), maxLength: 30 });

/** The orgs to offer as checkboxes: the ticked ones first (shares the user may take back), then the rest, at most 10. */
function orgBox(lang: Lang, orgs: OrgName[], ticked: string[]) {
  const sorted = [...orgs.filter((o) => ticked.includes(o.guildId)), ...orgs.filter((o) => !ticked.includes(o.guildId))].slice(0, MAX_ORG_OPTIONS);
  return new LabelBuilder().setLabel(t(lang, 'stock.field.shareIn')).setCheckboxGroupComponent(new CheckboxGroupBuilder()
    .setCustomId('share').setRequired(false).setMinValues(0).setMaxValues(sorted.length)
    .addOptions(sorted.map((o) => new CheckboxGroupOptionBuilder().setLabel(o.name.slice(0, 100)).setValue(o.guildId)
      .setDefault(ticked.includes(o.guildId)))));
}

const modal = (id: string, title: string) => new ModalBuilder().setCustomId(id).setTitle(title.slice(0, 45));

/** Defers (bookings may take a moment), runs the booking and answers; refusals become the answer. */
async function answer(interaction: ModalSubmitInteraction, lang: Lang, run: () => Promise<ReturnType<typeof bookedReply>>) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  try {
    await interaction.editReply(await run());
  } catch (err) {
    if (!(err instanceof UserError)) throw err;
    await interaction.editReply({ content: t(lang, err.key, err.vars), components: [] });
  }
}

/** The stats typed into a component's modal; none when its catalog entry offers none (the modal had no such field). */
function typedStats(interaction: ModalSubmitInteraction, entry: MaterialEntry | undefined): Record<string, string> | undefined {
  return entry?.component && entry.stats.length ? parseStatLines(textValue(interaction, 'stats'), entry.stats) : undefined;
}

async function onModal(area: Area, interaction: ModalSubmitInteraction, db: Db, lang: Lang) {
  const [, action, ...rest] = interaction.customId.split(':');
  const reply = (text: string, uuid: string | null | undefined) => bookedReply(area, text, lang, uuid);
  await answer(interaction, lang, async () => {
    const access = await requireMember(db, interaction);
    const actor = actorOf(access);
    if (action === 'add') {
      const [subject, locationUuid] = rest as [string, string];
      const kind = subject[0] === 'i' ? 'item' : 'resource';
      const uuid = subject.slice(1);
      const amount = checkAmount(textValue(interaction, 'amount'), kind);
      const shareIn = [...interaction.fields.getCheckboxGroup('share')];
      if (area.components) {
        const stats = typedStats(interaction, (await materialCatalog(db, lang)).get(uuid));
        return reply(await bookAdd(db, actor, { kind, uuid, locationUuid, quality: stock.COMPONENT_QUALITY, amount, shareIn, stats }, lang), uuid);
      }
      const quality = parseQuality(textValue(interaction, 'quality'));
      if (quality === null) throw new UserError('stock.err.invalidQuality');
      return reply(await bookAdd(db, actor, { kind, uuid, locationUuid, quality, amount, shareIn }, lang), uuid);
    }
    if (action === 'share') {
      const batchId = Number(rest[0]);
      const text = await bookShare(db, actor, batchId, [...interaction.fields.getCheckboxGroup('share')], lang);
      const shared = (await describe(db, actor, batchId, lang))?.batch;
      return reply(text, shared && (shared.resourceUuid ?? shared.itemUuid));
    }
    const [id, expected, target] = rest as [string, string, string | undefined];
    const batchId = Number(id);
    const batch = (await describe(db, actor, batchId, lang))?.batch;
    if (!batch) throw new UserError('stock.err.batchNotFound');
    const amount = checkAmount(textValue(interaction, 'amount'), batch.kind, action === 'adj');
    // The thumbnail of what the batch holds (also after a give or when it went empty)
    const uuid = batch.resourceUuid ?? batch.itemUuid;
    if (action === 'rm') return reply(await bookChange(db, actor, { op: 'remove', batchId, amount, expected }, lang), uuid);
    if (action === 'adj') {
      const stats = area.components ? typedStats(interaction, (await materialCatalog(db, lang)).get(batch.itemUuid!)) : undefined;
      return reply(await bookChange(db, actor, { op: 'adjust', batchId, amount, expected, stats }, lang), uuid);
    }
    if (action === 'mv') return reply(await bookChange(db, actor, { op: 'move', batchId, amount, expected, toLocationUuid: target! }, lang), uuid);
    if (action === 'give') {
      const entry = await rosterEntry(db, access.guildId, target!);
      if (!entry?.active) throw new UserError('stock.err.holderNotMember');
      return reply(await bookChange(db, actor, {
        op: 'give', batchId, amount, expected, toOwnerUserId: target!, toOwnerName: entry.displayName,
      }, lang), uuid);
    }
    throw new Error(`Unexpected modal ${interaction.customId}`);
  });
}

// --- autocomplete ----------------------------------------------------------------------------

async function autocomplete(area: Area, interaction: AutocompleteInteraction, lang: Lang, db: Db) {
  // No roster writes here (autocomplete must answer fast); non-members just get no suggestions
  const settings = interaction.inGuild() ? await findGuildSettings(db, interaction.guildId) : null;
  const access = settings && interaction.member ? accessOf(memberInfo(interaction.member).roleIds, settings) : null;
  if (!access?.member) return interaction.respond([]);
  const actor: stock.Actor = { userId: interaction.user.id, guildId: interaction.guildId!, source: 'bot' };
  const focused = interaction.options.getFocused(true);
  const query = String(focused.value);
  const sub = interaction.options.getSubcommand();
  let choices: Choice[] = [];
  if (focused.name === area.option) choices = await materialChoices(db, lang, query, area.components);
  else if (focused.name === 'location' || focused.name === 'to') choices = await locationChoices(db, lang, query);
  // Refinery jobs stay where they are and are not shared: only stored batches for move, give and share
  // A give lands unshared with the recipient: whether the batch is shared does not matter there
  else if (focused.name === 'batch') {
    choices = await batchChoices(db, actor, sub === 'remove' || sub === 'adjust' ? 'change' : 'move', lang, query, sub !== 'give', area.components);
  } else if (focused.name === 'member') {
    choices = (await searchMembers(db, actor.guildId!, query))
      .filter((m) => m.userId !== actor.userId)
      .map((m) => ({ name: (m.rsiHandle ? `${m.displayName} · ${m.rsiHandle}` : m.displayName).slice(0, 100), value: m.userId }));
  }
  await interaction.respond(choices);
}

// --- command ---------------------------------------------------------------------------------

const batchOpt = () => opt('batch', 'opt.batch', S, { required: true, ...auto });

// The subcommands that answer with a modal. Before it only cached lookups, the membership check and the
// actor's own batches are read: a modal must come within 3 s and cannot be deferred
const MODAL_SUBCOMMANDS = ['add', 'remove', 'adjust', 'move', 'give', 'share'];

function stockCommandOf(area: Area): BotCommand {
  const NAME = area.name;
  const cmd = (sub: string) => `cmd.${area.key}${sub ? `.${sub}` : ''}` as MessageKey;
  const pickOpt = area.components ? 'opt.component' : 'opt.material';
  return {
    data: {
      name: NAME,
      ...localizedDescription(cmd('')),
      contexts: [InteractionContextType.Guild],
      integration_types: [ApplicationIntegrationType.GuildInstall],
      options: [
        opt('add', cmd('add'), ApplicationCommandOptionType.Subcommand, {
          options: [opt(area.option, pickOpt, S, { required: true, ...auto }), opt('location', 'opt.location', S, { required: true, ...auto })],
        }),
        opt('remove', cmd('remove'), ApplicationCommandOptionType.Subcommand, { options: [batchOpt()] }),
        opt('adjust', cmd('adjust'), ApplicationCommandOptionType.Subcommand, { options: [batchOpt()] }),
        opt('move', cmd('move'), ApplicationCommandOptionType.Subcommand, {
          options: [batchOpt(), opt('to', 'opt.toLocation', S, { required: true, ...auto })],
        }),
        opt('give', cmd('give'), ApplicationCommandOptionType.Subcommand, {
          options: [batchOpt(), opt('member', 'opt.recipient', S, { required: true, ...auto })],
        }),
        opt('share', cmd('share'), ApplicationCommandOptionType.Subcommand, { options: [batchOpt()] }),
        opt('list', cmd('list'), ApplicationCommandOptionType.Subcommand, {
          options: [opt(area.option, area.components ? 'opt.onlyComponent' : 'opt.onlyMaterial', S, auto)],
        }),
        opt('find', cmd('find'), ApplicationCommandOptionType.Subcommand, {
          options: [
            opt(area.option, pickOpt, S, { required: true, ...auto }),
            // Components have no quality
            ...(area.components ? [] : [opt('min_quality', 'opt.minQuality', ApplicationCommandOptionType.Integer, { min_value: 0, max_value: 1000 })]),
          ],
        }),
      ],
    },
    modalSubcommands: MODAL_SUBCOMMANDS,
    execute: bySubcommand({
      async add(ctx) {
        const access = await requireMember(ctx.db, ctx.interaction);
        const material = (await pickedMaterial(area, ctx, true))!;
        const location = await pickedLocation(ctx, 'location');
        const orgs = await activeOrgs(ctx.db, access.userId);
        const m = modal(customId(NAME, 'add', `${material.kind === 'item' ? 'i' : 'r'}${material.uuid}`, location.uuid), ctx.t('stock.modal.add'))
          .addTextDisplayComponents(info(`**${escapeMarkdown(material.entry.label)}**\n${escapeMarkdown(location.label)}`))
          .addLabelComponents(
            textField('amount', ctx.t('stock.field.amount', { unit: unit(ctx.lang, material.kind) }), { description: ctx.t('stock.field.amountHint'), maxLength: 30 }),
            // A component has stats instead of a quality (none for looted-only ones)
            ...(!area.components ? [textField('quality', ctx.t('stock.field.quality'), { description: ctx.t('stock.field.qualityHint'), maxLength: 4 })]
              : material.entry.stats.length ? [statsField(ctx.lang, material.entry.stats, null)] : []),
            orgBox(ctx.lang, orgs, [access.guildId]),
          );
        await ctx.showModal(m);
      },
      async remove(ctx) {
        const access = await requireMember(ctx.db, ctx.interaction);
        const p = await pickedBatch(area, ctx, actorOf(access), 'change');
        await ctx.showModal(modal(customId(NAME, 'rm', p.batch.id, p.batch.quantity), ctx.t('stock.modal.remove'))
          .addTextDisplayComponents(info(await batchHead(ctx.db, p, ctx.lang)))
          .addLabelComponents(amountField(ctx.lang, p.batch.kind, p.batch.quantity)));
      },
      async adjust(ctx) {
        const access = await requireMember(ctx.db, ctx.interaction);
        const p = await pickedBatch(area, ctx, actorOf(access), 'change');
        const stats = area.components ? (await materialCatalog(ctx.db, ctx.lang)).get(p.batch.itemUuid!)?.stats ?? [] : [];
        await ctx.showModal(modal(customId(NAME, 'adj', p.batch.id, p.batch.quantity), ctx.t('stock.modal.adjust'))
          .addTextDisplayComponents(info(await batchHead(ctx.db, p, ctx.lang)))
          .addLabelComponents(
            amountField(ctx.lang, p.batch.kind, p.batch.quantity, 'stock.field.counted', 'stock.field.countedHint'),
            ...(stats.length ? [statsField(ctx.lang, stats, p.batch.stats)] : []),
          ));
      },
      async move(ctx) {
        const access = await requireMember(ctx.db, ctx.interaction);
        const p = await pickedBatch(area, ctx, actorOf(access), 'move');
        const to = await pickedLocation(ctx, 'to');
        if (to.uuid === p.batch.locationUuid) throw new UserError('stock.err.nothingToMove');
        await ctx.showModal(modal(customId(NAME, 'mv', p.batch.id, p.batch.quantity, to.uuid), ctx.t('stock.modal.move'))
          .addTextDisplayComponents(info(`${await batchHead(ctx.db, p, ctx.lang)}\n${ctx.t('stock.modal.to', { target: `**${escapeMarkdown(to.label)}**` })}`))
          .addLabelComponents(amountField(ctx.lang, p.batch.kind, p.batch.quantity)));
      },
      async give(ctx) {
        const access = await requireMember(ctx.db, ctx.interaction);
        const p = await pickedBatch(area, ctx, actorOf(access), 'move');
        const userId = ctx.interaction.options.getString('member', true);
        if (userId === access.userId) throw new UserError('stock.err.giveSelf');
        const entry = /^\d{17,20}$/.test(userId) ? await rosterEntry(ctx.db, access.guildId, userId) : null;
        if (!entry?.active) throw new UserError('stock.err.holderNotMember');
        await ctx.showModal(modal(customId(NAME, 'give', p.batch.id, p.batch.quantity, userId), ctx.t('stock.modal.give'))
          .addTextDisplayComponents(info(`${await batchHead(ctx.db, p, ctx.lang, false)}\n${ctx.t('stock.modal.to', { target: `**${escapeMarkdown(entry.displayName)}**` })}`))
          .addLabelComponents(amountField(ctx.lang, p.batch.kind, p.batch.quantity)));
      },
      async share(ctx) {
        const access = await requireMember(ctx.db, ctx.interaction);
        const p = await pickedBatch(area, ctx, actorOf(access), 'move');
        // Orgs the batch is shared in stay on offer even where the user is no longer active: taking back always works
        const active = await activeOrgs(ctx.db, access.userId);
        const gone = await orgNames(ctx.db, p.sharedIn.filter((g) => !active.some((o) => o.guildId === g)));
        await ctx.showModal(modal(customId(NAME, 'share', p.batch.id), ctx.t('stock.modal.share'))
          .addTextDisplayComponents(info(await batchHead(ctx.db, p, ctx.lang)))
          .addLabelComponents(orgBox(ctx.lang, [...active, ...gone], p.sharedIn)));
      },
      async list(ctx) {
        const access = await requireMember(ctx.db, ctx.interaction);
        const material = await pickedMaterial(area, ctx, false);
        await ctx.reply(await listPanel(area, ctx.db, access, { scope: 'p', page: 0, material: material?.uuid ?? null }, ctx.lang));
      },
      async find(ctx) {
        const access = await requireMember(ctx.db, ctx.interaction);
        const material = (await pickedMaterial(area, ctx, true))!;
        const min = area.components ? 0 : ctx.interaction.options.getInteger('min_quality') ?? 0;
        const found = named(await findStock(ctx.db, access.guildId, access.userId, material.uuid, min, ctx.lang), await materialCatalog(ctx.db, ctx.lang));
        const name = escapeMarkdown(material.entry.label);
        const minText = min > 0 ? ctx.t('stock.find.min', { min }) : '';
        const lines = found.slice(0, MAX_FIND).map((p) => `- ${[
          p.component ? escapeMarkdown(p.statsText ?? '') : `Q${p.batch.quality}`,
          amountText(ctx.lang, p.batch.quantity, p.batch.kind),
          escapeMarkdown(p.location),
          p.sharedIn.length ? `${ctx.t('stock.org')} (${escapeMarkdown(p.holderName ?? '?')})` : ctx.t('stock.personal'),
        ].filter(Boolean).join(' · ')}`);
        if (found.length > MAX_FIND) lines.push(ctx.t('bp.who.more', { count: found.length - MAX_FIND }));
        const container = addHead(new ContainerBuilder(), found.length
          ? [ctx.t('stock.find.title', { material: name, min: minText, count: found.length }), ...lines].join('\n')
          : ctx.t('stock.find.none', { material: name, min: minText }), thumbUrl(material.uuid));
        // Your own batches and this org's: the web app's "All" holds both
        const row = linkRow(area, ctx.lang, 'all');
        if (row) container.addActionRowComponents(row);
        await ctx.reply(panel(container));
      },
    }),
    autocomplete: (interaction, lang, db) => autocomplete(area, interaction, lang, db),
    modal: (ctx) => onModal(area, ctx.interaction, ctx.db, ctx.lang),
    async component(ctx) {
      const [, action, ...rest] = ctx.interaction.customId.split(':');
      const access = await requireMember(ctx.db, ctx.interaction);
      // "Your stock" under a booking and "Show all" on the board open a new panel; the list's own buttons redraw it
      if (action === 'mine' || action === 'org') {
        const p = await listPanel(area, ctx.db, access, { scope: action === 'mine' ? 'p' : 'o', page: 0, material: null }, ctx.lang);
        await ctx.interaction.reply({ ...p, flags: p.flags | MessageFlags.Ephemeral });
        return;
      }
      if (action !== 'list') throw new Error(`Unexpected component ${ctx.interaction.customId}`);
      await ctx.interaction.update(await listPanel(area, ctx.db, access, parseListId(rest), ctx.lang));
    },
  };
}

export const stockCommand = stockCommandOf(STOCK);
export const compsCommand = stockCommandOf(COMPS);
