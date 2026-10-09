// /qm-stock: options pick what to book (autocomplete), a modal asks for the rest (amount, quality,
// orgs), lists and searches answer as panels. Submitting a modal books right away: the modal shows the
// batch and the amount, like the web app's dialogs.
import {
  ActionRowBuilder, ApplicationCommandOptionType, ApplicationIntegrationType, ButtonBuilder, ButtonStyle, CheckboxGroupBuilder,
  CheckboxGroupOptionBuilder, ContainerBuilder, InteractionContextType, LabelBuilder, MessageFlags, ModalBuilder, SeparatorBuilder,
  TextDisplayBuilder, escapeMarkdown,
  type APIApplicationCommandOption, type AutocompleteInteraction, type ModalSubmitInteraction,
} from 'discord.js';
import type { Db } from '../../db/client.ts';
import { formatMicros, toMicros } from '../../planner/plan.ts';
import { formatAmount, parseAmount } from '../../stock/amount.ts';
import {
  activeOrgs, findStock, locationCatalog, materialCatalog, materialTotal, orgNames, pickableBatches, stockList,
  type BatchPick, type OrgName, type PickableBatch, type StockFilter,
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
import { customId, panel, textField, textValue, webAppButton } from '../ui.ts';

const NAME = 'qm-stock';
const PAGE_SIZE = 20;
const MAX_FIND = 25;
// Discord's limit for the options of a checkbox group
const MAX_ORG_OPTIONS = 10;

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

/** A batch as it looks now (names from the catalog caches, shares from the database). */
async function describe(db: Db, actor: stock.Actor, batchId: number, lang: Lang): Promise<PickableBatch | undefined> {
  return (await pickableBatches(db, actor, 'change', lang)).find((p) => p.batch.id === batchId);
}

// A booking's reply: line 1 what happened ("📥 Booked **2 SCU** · **Metal** Q900"), line 2 the batch
// as it is now (amount · place · shares), line 3 small: the material in your stock

/** "**Metal** Q900": what a booking was about. */
const subject = (p: Pick<PickableBatch, 'material'> & { batch: Pick<stock.Batch, 'quality'> }) =>
  `**${escapeMarkdown(p.material)}** Q${p.batch.quality}`;

/** "12 SCU · Area18 · shared in Org A, Org B" (or "· personal"). */
async function batchNow(db: Db, p: PickableBatch, lang: Lang, withShares = true): Promise<string> {
  const parts = [amountText(lang, p.batch.quantity, p.batch.kind), escapeMarkdown(p.location)];
  if (withShares) {
    const orgs = (await orgNames(db, p.sharedIn)).map((o) => escapeMarkdown(o.name));
    parts.push(orgs.length ? t(lang, 'stock.result.sharedIn', { orgs: orgs.join(', ') }) : t(lang, 'stock.result.personal'));
  }
  return parts.join(' · ');
}

/** A modal's head: the batch as in a result ("**Metal** Q900", then "12 SCU · Area18 · personal"). */
async function batchHead(db: Db, p: PickableBatch, lang: Lang, withShares = true): Promise<string> {
  return `${subject(p)}\n${await batchNow(db, p, lang, withShares)}`;
}

/** "-# Metal in your stock: 30 SCU": the material in its owner's stock after the booking. */
async function totalLine(db: Db, lang: Lang, material: string, b: Pick<stock.Batch, 'ownerUserId' | 'resourceUuid' | 'itemUuid' | 'kind'>) {
  const total = await materialTotal(db, { personalOf: b.ownerUserId }, b.resourceUuid ?? b.itemUuid!);
  return `-# ${t(lang, 'stock.result.total', { material: escapeMarkdown(material), amount: amountText(lang, total, b.kind) })}`;
}

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
  return [
    t(lang, 'stock.added', { amount: amountText(lang, r.journal[0]!.delta, r.batch!.kind), what: subject(after) }),
    t(lang, 'stock.result.batch', { batch: await batchNow(db, after, lang) }),
    await totalLine(db, lang, after.material, r.batch!),
  ].join('\n') + note;
}

/** A change of one batch as submitted in its modal; `expected` = the amount the modal showed. */
export type Change =
  | { op: 'remove'; batchId: number; amount: string; expected: string }
  | { op: 'adjust'; batchId: number; amount: string; expected: string }
  | { op: 'move'; batchId: number; amount: string; expected: string; toLocationUuid: string }
  | { op: 'give'; batchId: number; amount: string; expected: string; toOwnerUserId: string; toOwnerName: string };

/** Books a change with the rights the user has now; the text for the reply. */
export async function bookChange(db: Db, actor: stock.Actor, c: Change, lang: Lang): Promise<string> {
  if (c.op === 'remove') {
    const before = await describe(db, actor, c.batchId, lang);
    const r = await book(() => stock.remove(db, actor, { batchId: c.batchId, amount: c.amount, expected: c.expected }));
    const j = r.journal[0]!;
    const removed = amountText(lang, j.delta.replace(/^-/, ''), j.kind);
    return [
      t(lang, 'stock.removed', { amount: removed, what: before ? subject(before) : '?' }),
      await batchAfter(db, actor, r.batch, before, lang),
      await totalLine(db, lang, before?.material ?? '?', j),
    ].join('\n');
  }
  if (c.op === 'adjust') {
    const before = await describe(db, actor, c.batchId, lang);
    const r = await book(() => stock.adjust(db, actor, { batchId: c.batchId, amount: c.amount, expected: c.expected }));
    const j = r.journal[0]!;
    const delta = `${j.delta.startsWith('-') ? '' : '+'}${amountText(lang, j.delta, j.kind)}`;
    return [
      t(lang, 'stock.adjusted', { delta, what: before ? subject(before) : '?' }),
      await batchAfter(db, actor, r.batch, before, lang),
      await totalLine(db, lang, before?.material ?? '?', j),
    ].join('\n');
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
    const material = materials.get(b.resourceUuid ?? b.itemUuid!)?.name ?? '?';
    return [
      t(lang, 'stock.given', { amount: amountText(lang, j.delta, j.kind), what: subject({ material, batch: b }) }),
      t(lang, 'stock.result.to', { name: escapeMarkdown(c.toOwnerName), location: escapeMarkdown(locations.get(b.locationUuid)?.short ?? '?') }),
    ].join('\n');
  }
  const moved = (await describe(db, actor, r.batch!.id, lang))!;
  return [
    t(lang, 'stock.moved', { amount: amountText(lang, j.delta, j.kind), what: subject(moved) }),
    t(lang, 'stock.result.batch', { batch: await batchNow(db, moved, lang) }),
    await totalLine(db, lang, moved.material, r.batch!),
  ].join('\n');
}

/** Line 2 after a remove or correction: what is left of the batch, or "empty" and where it was. */
async function batchAfter(db: Db, actor: stock.Actor, batch: stock.Batch | null, before: PickableBatch | undefined, lang: Lang) {
  const left = batch ? await describe(db, actor, batch.id, lang) : undefined;
  if (left) return t(lang, 'stock.result.batch', { batch: await batchNow(db, left, lang) });
  return t(lang, 'stock.result.empty', { location: escapeMarkdown(before?.location ?? '?') });
}

/** Sets the orgs a batch is shared in; the text for the reply. */
export async function bookShare(db: Db, actor: stock.Actor, batchId: number, guildIds: string[], lang: Lang): Promise<string> {
  const r = await book(() => stock.share(db, actor, { batchId, guildIds }));
  const p = (await describe(db, actor, r.batch.id, lang))!;
  const batch = `${subject(p)} · ${amountText(lang, p.batch.quantity, p.batch.kind)} · ${escapeMarkdown(p.location)}`;
  if (!r.guildIds.length) return [t(lang, 'stock.unshared'), batch].join('\n');
  const names = (await orgNames(db, r.guildIds)).map((o) => escapeMarkdown(o.name));
  return [t(lang, 'stock.sharedIn', { orgs: names.join(', ') }), batch].join('\n');
}

// --- panels ----------------------------------------------------------------------------------

/** Which stock a list shows: p = personal (everything you own), o = shared in this org, a = both. */
export type ListScope = 'p' | 'o' | 'a';

export interface ListView {
  scope: ListScope;
  page: number;
  // Only this material (UUID)
  material: string | null;
}

const listId = (v: ListView) => customId(NAME, 'list', v.scope, v.page, v.material ?? '-');

function parseListId(parts: string[]): ListView {
  const [scope, page, material] = parts;
  if (scope !== 'p' && scope !== 'o' && scope !== 'a') throw new Error(`Unexpected list scope ${scope}`);
  return { scope, page: Number(page) || 0, material: material && material !== '-' ? material : null };
}

/**
 * The lines of one list page, grouped by material with each material's total over the whole list. The owner
 * column: the org list names who shares it, "All" marks your own "Pers.", your own list marks what you share.
 */
export function listLines(entries: PickableBatch[], scope: ListScope, userId: string, page: number, lang: Lang) {
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
      `${p.batch.state === 'refining' ? '⚗️ ' : ''}Q${p.batch.quality}`,
      amountText(lang, p.batch.quantity, p.batch.kind),
      escapeMarkdown(p.location),
      owner,
    ];
    lines.push(`- ${parts.filter(Boolean).join(' · ')}`);
  }
  return { lines, page: current, pages };
}

const linkRow = (lang: Lang, ...buttons: ButtonBuilder[]) => {
  const link = webAppButton(lang);
  const all = link ? [...buttons, link] : buttons;
  return all.length ? new ActionRowBuilder<ButtonBuilder>().addComponents(all) : null;
};

/** The list panel: scope buttons, one page of lines, paging and the web app link. */
async function listPanel(db: Db, actor: { userId: string; guildId: string }, view: ListView, lang: Lang) {
  const tr = (key: MessageKey, vars?: MessageVars) => t(lang, key, vars);
  const scope: StockFilter['scope'] = view.scope === 'p' ? { personalOf: actor.userId }
    : view.scope === 'o' ? { guildId: actor.guildId } : { allOf: actor.userId };
  const entries = await stockList(db, { scope, subjectUuid: view.material ?? undefined }, lang);
  const orgName = (await orgNames(db, [actor.guildId]))[0]?.name ?? tr('stock.org');
  const scopeName = view.scope === 'p' ? tr('stock.scope.personal') : view.scope === 'o' ? orgName : tr('stock.scope.all');
  const { lines, page, pages } = listLines(entries, view.scope, actor.userId, view.page, lang);

  const scopeButton = (scope: ListScope, label: string) => new ButtonBuilder()
    .setCustomId(listId({ ...view, scope, page: 0 })).setLabel(label.slice(0, 80))
    .setStyle(scope === view.scope ? ButtonStyle.Primary : ButtonStyle.Secondary);
  const container = new ContainerBuilder()
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(tr('stock.list.title', { scope: escapeMarkdown(scopeName), count: entries.length })))
    .addActionRowComponents(new ActionRowBuilder<ButtonBuilder>().addComponents(
      scopeButton('p', tr('stock.scope.personal')), scopeButton('o', orgName), scopeButton('a', tr('stock.scope.all')),
    ))
    .addSeparatorComponents(new SeparatorBuilder())
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(lines.length ? lines.join('\n') : tr('stock.list.empty')));
  const paging = pages > 1 ? [
    new ButtonBuilder().setCustomId(listId({ ...view, page: page - 1 })).setLabel('◀').setStyle(ButtonStyle.Secondary).setDisabled(page === 0),
    new ButtonBuilder().setCustomId(listId({ ...view, page: page + 1 })).setLabel('▶').setStyle(ButtonStyle.Secondary).setDisabled(page === pages - 1),
  ] : [];
  if (pages > 1) container.addTextDisplayComponents(new TextDisplayBuilder().setContent(`-# ${tr('list.page', { page: page + 1, pages })}`));
  const row = linkRow(lang, ...paging);
  if (row) container.addActionRowComponents(row);
  return panel(container);
}

/** The reply after a booking: what happened, a button to the list and the web app link. */
function bookedReply(text: string, lang: Lang) {
  const mine = new ButtonBuilder().setCustomId(customId(NAME, 'mine')).setLabel(t(lang, 'stock.btn.yourStock')).setStyle(ButtonStyle.Secondary);
  return { content: text, components: [linkRow(lang, mine)!], allowedMentions: { parse: [] } };
}

// --- input -----------------------------------------------------------------------------------

/** Material option value `<kind>:<uuid>` (from the suggestions), checked against the catalog. */
async function pickedMaterial(ctx: CommandContext, required: boolean) {
  const value = ctx.interaction.options.getString('material', required);
  if (value === null) return null;
  const m = /^(resource|item):(.+)$/.exec(value);
  const entry = m ? (await materialCatalog(ctx.db, ctx.lang)).get(m[2]!) : undefined;
  if (!entry) throw new UserError('stock.err.unknownSubject');
  return { kind: m![1] as 'resource' | 'item', uuid: m![2]!, entry };
}

async function pickedLocation(ctx: CommandContext, name: string) {
  const uuid = ctx.interaction.options.getString(name, true);
  const entry = (await locationCatalog(ctx.db, ctx.lang)).get(uuid);
  if (!entry) throw new UserError('stock.err.unknownLocation');
  return entry;
}

/** The batch option: one the actor may change (also checks that it exists and is theirs). */
async function pickedBatch(ctx: CommandContext, actor: stock.Actor, pick: BatchPick): Promise<PickableBatch> {
  const id = Number(ctx.interaction.options.getString('batch', true));
  const found = Number.isInteger(id) ? (await pickableBatches(ctx.db, actor, pick, ctx.lang)).find((p) => p.batch.id === id) : undefined;
  if (!found) throw new UserError('stock.err.batchNotFound');
  return found;
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

async function onModal(interaction: ModalSubmitInteraction, db: Db, lang: Lang) {
  const [, action, ...rest] = interaction.customId.split(':');
  await answer(interaction, lang, async () => {
    const access = await requireMember(db, interaction);
    const actor = actorOf(access);
    if (action === 'add') {
      const [subject, locationUuid] = rest as [string, string];
      const kind = subject[0] === 'i' ? 'item' : 'resource';
      const quality = parseQuality(textValue(interaction, 'quality'));
      if (quality === null) throw new UserError('stock.err.invalidQuality');
      const amount = checkAmount(textValue(interaction, 'amount'), kind);
      const shareIn = [...interaction.fields.getCheckboxGroup('share')];
      return bookedReply(await bookAdd(db, actor, { kind, uuid: subject.slice(1), locationUuid, quality, amount, shareIn }, lang), lang);
    }
    if (action === 'share') {
      return bookedReply(await bookShare(db, actor, Number(rest[0]), [...interaction.fields.getCheckboxGroup('share')], lang), lang);
    }
    const [id, expected, target] = rest as [string, string, string | undefined];
    const batchId = Number(id);
    const kind = (await describe(db, actor, batchId, lang))?.batch.kind;
    if (!kind) throw new UserError('stock.err.batchNotFound');
    const amount = checkAmount(textValue(interaction, 'amount'), kind, action === 'adj');
    if (action === 'rm') return bookedReply(await bookChange(db, actor, { op: 'remove', batchId, amount, expected }, lang), lang);
    if (action === 'adj') return bookedReply(await bookChange(db, actor, { op: 'adjust', batchId, amount, expected }, lang), lang);
    if (action === 'mv') return bookedReply(await bookChange(db, actor, { op: 'move', batchId, amount, expected, toLocationUuid: target! }, lang), lang);
    if (action === 'give') {
      const entry = await rosterEntry(db, access.guildId, target!);
      if (!entry?.active) throw new UserError('stock.err.holderNotMember');
      return bookedReply(await bookChange(db, actor, {
        op: 'give', batchId, amount, expected, toOwnerUserId: target!, toOwnerName: entry.displayName,
      }, lang), lang);
    }
    throw new Error(`Unexpected modal ${interaction.customId}`);
  });
}

// --- autocomplete ----------------------------------------------------------------------------

async function autocomplete(interaction: AutocompleteInteraction, lang: Lang, db: Db) {
  // No roster writes here (autocomplete must answer fast); non-members just get no suggestions
  const settings = interaction.inGuild() ? await findGuildSettings(db, interaction.guildId) : null;
  const access = settings && interaction.member ? accessOf(memberInfo(interaction.member).roleIds, settings) : null;
  if (!access?.member) return interaction.respond([]);
  const actor: stock.Actor = { userId: interaction.user.id, guildId: interaction.guildId!, source: 'bot' };
  const focused = interaction.options.getFocused(true);
  const query = String(focused.value);
  const sub = interaction.options.getSubcommand();
  let choices: Choice[] = [];
  if (focused.name === 'material') choices = await materialChoices(db, lang, query, false);
  else if (focused.name === 'location' || focused.name === 'to') choices = await locationChoices(db, lang, query);
  // Refinery jobs stay where they are and are not shared: only stored batches for move, give and share
  // A give lands unshared with the recipient: whether the batch is shared does not matter there
  else if (focused.name === 'batch') choices = await batchChoices(db, actor, sub === 'remove' || sub === 'adjust' ? 'change' : 'move', lang, query, sub !== 'give');
  else if (focused.name === 'member') {
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

export const stockCommand: BotCommand = {
  data: {
    name: NAME,
    ...localizedDescription('cmd.stock'),
    contexts: [InteractionContextType.Guild],
    integration_types: [ApplicationIntegrationType.GuildInstall],
    options: [
      opt('add', 'cmd.stock.add', ApplicationCommandOptionType.Subcommand, {
        options: [opt('material', 'opt.material', S, { required: true, ...auto }), opt('location', 'opt.location', S, { required: true, ...auto })],
      }),
      opt('remove', 'cmd.stock.remove', ApplicationCommandOptionType.Subcommand, { options: [batchOpt()] }),
      opt('adjust', 'cmd.stock.adjust', ApplicationCommandOptionType.Subcommand, { options: [batchOpt()] }),
      opt('move', 'cmd.stock.move', ApplicationCommandOptionType.Subcommand, {
        options: [batchOpt(), opt('to', 'opt.toLocation', S, { required: true, ...auto })],
      }),
      opt('give', 'cmd.stock.give', ApplicationCommandOptionType.Subcommand, {
        options: [batchOpt(), opt('member', 'opt.recipient', S, { required: true, ...auto })],
      }),
      opt('share', 'cmd.stock.share', ApplicationCommandOptionType.Subcommand, { options: [batchOpt()] }),
      opt('list', 'cmd.stock.list', ApplicationCommandOptionType.Subcommand, {
        options: [opt('material', 'opt.onlyMaterial', S, auto)],
      }),
      opt('find', 'cmd.stock.find', ApplicationCommandOptionType.Subcommand, {
        options: [
          opt('material', 'opt.material', S, { required: true, ...auto }),
          opt('min_quality', 'opt.minQuality', ApplicationCommandOptionType.Integer, { min_value: 0, max_value: 1000 }),
        ],
      }),
    ],
  },
  modalSubcommands: MODAL_SUBCOMMANDS,
  execute: bySubcommand({
    async add(ctx) {
      const access = await requireMember(ctx.db, ctx.interaction);
      const material = (await pickedMaterial(ctx, true))!;
      if (material.entry.isOre) throw new UserError('stock.err.oreViaRefinery');
      const location = await pickedLocation(ctx, 'location');
      const orgs = await activeOrgs(ctx.db, access.userId);
      const m = modal(customId(NAME, 'add', `${material.kind === 'item' ? 'i' : 'r'}${material.uuid}`, location.uuid), ctx.t('stock.modal.add'))
        .addTextDisplayComponents(info(`**${escapeMarkdown(material.entry.name)}**\n${escapeMarkdown(location.label)}`))
        .addLabelComponents(
          textField('amount', ctx.t('stock.field.amount', { unit: unit(ctx.lang, material.kind) }), { description: ctx.t('stock.field.amountHint'), maxLength: 30 }),
          textField('quality', ctx.t('stock.field.quality'), { description: ctx.t('stock.field.qualityHint'), maxLength: 4 }),
          orgBox(ctx.lang, orgs, [access.guildId]),
        );
      await ctx.showModal(m);
    },
    async remove(ctx) {
      const access = await requireMember(ctx.db, ctx.interaction);
      const p = await pickedBatch(ctx, actorOf(access), 'change');
      await ctx.showModal(modal(customId(NAME, 'rm', p.batch.id, p.batch.quantity), ctx.t('stock.modal.remove'))
        .addTextDisplayComponents(info(await batchHead(ctx.db, p, ctx.lang)))
        .addLabelComponents(amountField(ctx.lang, p.batch.kind, p.batch.quantity)));
    },
    async adjust(ctx) {
      const access = await requireMember(ctx.db, ctx.interaction);
      const p = await pickedBatch(ctx, actorOf(access), 'change');
      await ctx.showModal(modal(customId(NAME, 'adj', p.batch.id, p.batch.quantity), ctx.t('stock.modal.adjust'))
        .addTextDisplayComponents(info(await batchHead(ctx.db, p, ctx.lang)))
        .addLabelComponents(amountField(ctx.lang, p.batch.kind, p.batch.quantity, 'stock.field.counted', 'stock.field.countedHint')));
    },
    async move(ctx) {
      const access = await requireMember(ctx.db, ctx.interaction);
      const p = await pickedBatch(ctx, actorOf(access), 'move');
      const to = await pickedLocation(ctx, 'to');
      if (to.uuid === p.batch.locationUuid) throw new UserError('stock.err.nothingToMove');
      await ctx.showModal(modal(customId(NAME, 'mv', p.batch.id, p.batch.quantity, to.uuid), ctx.t('stock.modal.move'))
        .addTextDisplayComponents(info(`${await batchHead(ctx.db, p, ctx.lang)}\n${ctx.t('stock.modal.to', { target: `**${escapeMarkdown(to.label)}**` })}`))
        .addLabelComponents(amountField(ctx.lang, p.batch.kind, p.batch.quantity)));
    },
    async give(ctx) {
      const access = await requireMember(ctx.db, ctx.interaction);
      const p = await pickedBatch(ctx, actorOf(access), 'move');
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
      const p = await pickedBatch(ctx, actorOf(access), 'move');
      // Orgs the batch is shared in stay on offer even where the user is no longer active: taking back always works
      const active = await activeOrgs(ctx.db, access.userId);
      const gone = await orgNames(ctx.db, p.sharedIn.filter((g) => !active.some((o) => o.guildId === g)));
      await ctx.showModal(modal(customId(NAME, 'share', p.batch.id), ctx.t('stock.modal.share'))
        .addTextDisplayComponents(info(await batchHead(ctx.db, p, ctx.lang)))
        .addLabelComponents(orgBox(ctx.lang, [...active, ...gone], p.sharedIn)));
    },
    async list(ctx) {
      const access = await requireMember(ctx.db, ctx.interaction);
      const material = await pickedMaterial(ctx, false);
      await ctx.reply(await listPanel(ctx.db, access, { scope: 'p', page: 0, material: material?.uuid ?? null }, ctx.lang));
    },
    async find(ctx) {
      const access = await requireMember(ctx.db, ctx.interaction);
      const material = (await pickedMaterial(ctx, true))!;
      const min = ctx.interaction.options.getInteger('min_quality') ?? 0;
      const found = await findStock(ctx.db, access.guildId, access.userId, material.uuid, min, ctx.lang);
      const name = escapeMarkdown(material.entry.name);
      const minText = min > 0 ? ctx.t('stock.find.min', { min }) : '';
      const lines = found.slice(0, MAX_FIND).map((p) => `- ${[
        `Q${p.batch.quality}`,
        amountText(ctx.lang, p.batch.quantity, p.batch.kind),
        escapeMarkdown(p.location),
        p.sharedIn.length ? `${ctx.t('stock.org')} (${escapeMarkdown(p.holderName ?? '?')})` : ctx.t('stock.personal'),
      ].join(' · ')}`);
      if (found.length > MAX_FIND) lines.push(ctx.t('bp.who.more', { count: found.length - MAX_FIND }));
      const container = new ContainerBuilder().addTextDisplayComponents(new TextDisplayBuilder().setContent(found.length
        ? [ctx.t('stock.find.title', { material: name, min: minText, count: found.length }), ...lines].join('\n')
        : ctx.t('stock.find.none', { material: name, min: minText })));
      const row = linkRow(ctx.lang);
      if (row) container.addActionRowComponents(row);
      await ctx.reply(panel(container));
    },
  }),
  autocomplete,
  modal: (ctx) => onModal(ctx.interaction, ctx.db, ctx.lang),
  async component(ctx) {
    const [, action, ...rest] = ctx.interaction.customId.split(':');
    const access = await requireMember(ctx.db, ctx.interaction);
    // "Your stock" under a booking opens a new panel; the list's own buttons redraw it
    if (action === 'mine') {
      const p = await listPanel(ctx.db, access, { scope: 'p', page: 0, material: null }, ctx.lang);
      await ctx.interaction.reply({ ...p, flags: p.flags | MessageFlags.Ephemeral });
      return;
    }
    if (action !== 'list') throw new Error(`Unexpected component ${ctx.interaction.customId}`);
    await ctx.interaction.update(await listPanel(ctx.db, access, parseListId(rest), ctx.lang));
  },
};
