// /qm-refinery: refinery work orders, always personal (like the web app: no org needed). start and done
// search the station or job as options and take the ore rows as text lines in a modal; start shows a
// preview first (the lines must be resolved), done books on submit. list answers as a panel.
import {
  ActionRowBuilder, ApplicationCommandOptionType, ApplicationIntegrationType, ButtonBuilder, ButtonStyle, ContainerBuilder,
  InteractionContextType, MessageFlags, ModalBuilder, SeparatorBuilder, TextDisplayBuilder, escapeMarkdown,
  type APIApplicationCommandOption, type AutocompleteInteraction, type ModalSubmitInteraction,
} from 'discord.js';
import type { Db } from '../../db/client.ts';
import { refineryLocations } from '../../ext/refineries.ts';
import { formatMicros, toMicros } from '../../planner/plan.ts';
import { formatAmount } from '../../stock/amount.ts';
import { locationCatalog, materialCatalog, pickableBatches, searchWords, type PickableBatch } from '../../stock/lookup.ts';
import { addOreName, type OreCatalog } from '../../stock/ore-names.ts';
import * as stock from '../../stock/service.ts';
import { UserError } from '../errors.ts';
import { localizedDescription, t, type Lang, type MessageKey } from '../i18n.ts';
import {
  doneText, formatDuration, parseDoneText, parseDuration, parseOreLines, type DoneRow, type LineError,
} from '../refinery-lines.ts';
import { bySubcommand, type BotCommand, type CommandContext } from '../registry.ts';
import { CONFIRM_TTL_MS, getState, putState } from '../state.ts';
import { customId, panel, textField, textValue, webAppButton } from '../ui.ts';

const NAME = 'qm-refinery';
const S = ApplicationCommandOptionType.String;
// Text inputs hold up to 4000 characters: 30 ore lines fit easily
const MAX_TEXT = 4000;
// Panel text stays well below Discord's 4000 characters per message
const MAX_PANEL_TEXT = 3500;

const opt = (name: string, key: MessageKey, type: ApplicationCommandOptionType, extra: Record<string, unknown> = {}) =>
  ({ name, ...localizedDescription(key), type, ...extra }) as APIApplicationCommandOption;

// Refinery jobs are personal: no org involved
const actorOf = (userId: string): stock.Actor => ({ userId, guildId: null, source: 'bot' });

async function book<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    if (err instanceof stock.StockError) throw new UserError(`stock.err.${err.code}`);
    throw err;
  }
}

const sumScu = (amounts: string[]) => formatMicros(amounts.reduce((s, a) => s + toMicros(a), 0n));
const unixOf = (iso: string) => Math.floor(new Date(iso).getTime() / 1000);
// User text inside inline code: no backticks, short
const codeText = (text: string) => (text.length > 40 ? `${text.slice(0, 39)}…` : text).replace(/`/g, "'");

/** Ore names in both languages (the user may type either), rebuilt when a catalog cache reloads. */
let oreCache: { de: unknown; en: unknown; value: OreCatalog } | null = null;
async function oreCatalog(db: Db): Promise<OreCatalog> {
  const [de, en] = [await materialCatalog(db, 'de'), await materialCatalog(db, 'en')];
  if (oreCache?.de === de && oreCache.en === en) return oreCache.value;
  const value: OreCatalog = { ores: new Map(), oreParts: [] };
  for (const m of [...de.values(), ...en.values()]) if (m.isOre) addOreName(value, m.name, m.uuid);
  oreCache = { de, en, value };
  return value;
}

// --- start: modal, preview, booking ------------------------------------------------------------

export interface StartDraft {
  locationUuid: string;
  station: string;
  // As typed (kept for Edit)
  duration: string;
  ores: string;
  // What the preview showed, set while it is complete: Start books exactly this
  ready: stock.RefineStartInput | null;
  // A Start click is booking (a second click must not book again)
  booking: boolean;
}

function startModal(lang: Lang, token: string, d: StartDraft): ModalBuilder {
  const head = [`**${escapeMarkdown(d.station)}**`];
  return new ModalBuilder().setCustomId(customId(NAME, 'start', token)).setTitle(t(lang, 'refinery.start.title'))
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(head.join('\n')))
    .addLabelComponents(
      // Optional: in a hurry the job is booked without an end (no countdown then)
      textField('duration', t(lang, 'refinery.field.duration'), { description: t(lang, 'refinery.field.durationHint'), value: d.duration, required: false, maxLength: 40 }),
      textField('ores', t(lang, 'refinery.field.ores'), {
        description: t(lang, 'refinery.field.oresHint'), value: d.ores, placeholder: 'Quantanium 820 12.5\nLaranite 610 40',
        paragraph: true, maxLength: MAX_TEXT,
      }),
    );
}

const lineErrorKey = (e: LineError): MessageKey => `refinery.lineErr.${e}`;

/** Resolves the draft's text into the work order it would book and the preview panel showing it. */
export async function previewPanel(db: Db, lang: Lang, token: string, d: StartDraft) {
  const tr = (key: MessageKey, vars?: Record<string, string | number>) => t(lang, key, vars);
  const parsed = parseOreLines(d.ores, await oreCatalog(db), stock.MAX_REFINE_ROWS);
  // undefined: left empty (allowed), null: not understood
  const seconds = d.duration.trim() ? parseDuration(d.duration) : undefined;
  const materials = await materialCatalog(db, lang);
  const lines: string[] = [];
  const rows: stock.RefineStartRow[] = [];
  for (const r of parsed.rows) {
    // Only the user's own expectation (the terminal shows it): no estimates here
    const { expectedYield } = r;
    rows.push({ oreUuid: r.oreUuid, quality: r.quality, amount: r.amount, ...(expectedYield === undefined ? {} : { expectedYield }) });
    const name = escapeMarkdown(materials.get(r.oreUuid)?.name ?? '?');
    const result = expectedYield === undefined ? '' : ` → ${expectedYield} ${tr('unit.scu')}`;
    lines.push(`- **${name}** · Q${r.quality} · ${r.amount} ${tr('unit.scu')}${result}`);
  }
  const problems = parsed.errors.map((e) => `- ⚠️ ${tr('refinery.line', { line: e.line, text: codeText(e.text), error: tr(lineErrorKey(e.error)) })}`);
  if (seconds === null) problems.unshift(`- ⚠️ ${tr('refinery.preview.badDuration', { text: codeText(d.duration) })}`);
  if (parsed.tooMany) problems.push(`- ⚠️ ${tr('refinery.preview.tooMany', { max: stock.MAX_REFINE_ROWS, count: parsed.rows.length })}`);
  if (!parsed.rows.length && !parsed.errors.length) problems.push(`- ⚠️ ${tr('refinery.preview.noRows')}`);
  d.ready = problems.length || seconds === null ? null : { locationUuid: d.locationUuid, ...(seconds === undefined ? {} : { durationSeconds: seconds }), rows };

  const summary = [`${sumScu(parsed.rows.map((r) => r.amount))} ${tr('unit.scu')}`];
  if (seconds === undefined) summary.push(tr('refinery.durationOpen'));
  else if (seconds !== null) summary.push(tr('refinery.preview.readyIn', { duration: formatDuration(seconds) }));
  let body = [...lines, ...problems].join('\n');
  if (body.length > MAX_PANEL_TEXT) body = `${body.slice(0, MAX_PANEL_TEXT)}\n…`;
  const container = new ContainerBuilder()
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(
      `### ${tr('refinery.preview.title', { station: escapeMarkdown(d.station) })}\n-# ${summary.join(' · ')}`))
    .addSeparatorComponents(new SeparatorBuilder())
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(body || '-'))
    .addActionRowComponents(new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(customId(NAME, 'go', token)).setLabel(tr('refinery.btn.start')).setStyle(ButtonStyle.Success).setDisabled(!d.ready),
      new ButtonBuilder().setCustomId(customId(NAME, 'edit', token)).setLabel(tr('refinery.btn.edit')).setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(customId(NAME, 'cancel', token)).setLabel(tr('btn.cancel')).setStyle(ButtonStyle.Secondary),
    ));
  return panel(container);
}

/** A panel of text only (results, cancelled, expired), with the web app link where it helps. */
function textPanel(lang: Lang, text: string, link = false) {
  const container = new ContainerBuilder().addTextDisplayComponents(new TextDisplayBuilder().setContent(text));
  const web = link ? webAppButton(lang) : null;
  if (web) container.addActionRowComponents(new ActionRowBuilder<ButtonBuilder>().addComponents(web));
  return panel(container);
}

/** Replies to a modal submit: a new ephemeral panel, or the panel the modal was opened from. */
async function answerModal(interaction: ModalSubmitInteraction, content: ReturnType<typeof panel>) {
  if (interaction.isFromMessage()) await interaction.update(content);
  else await interaction.reply({ ...content, flags: content.flags | MessageFlags.Ephemeral });
}

async function onStartSubmit(interaction: ModalSubmitInteraction, db: Db, lang: Lang, token: string) {
  const state = getState<StartDraft>(token, interaction.user.id);
  if (!state.ok) return answerModal(interaction, textPanel(lang, t(lang, 'ui.panelExpired')));
  const d = state.value;
  d.duration = textValue(interaction, 'duration');
  d.ores = interaction.fields.getTextInputValue('ores');
  await answerModal(interaction, await previewPanel(db, lang, token, d));
}

// --- done: modal with one line per ore ------------------------------------------------------------

interface DoneDraft {
  jobId: string;
  station: string;
  rows: (DoneRow & { batchId: number; quantity: string })[];
  // The text last submitted (kept for "Try again")
  text: string;
}

function doneModal(lang: Lang, token: string, d: DoneDraft): ModalBuilder {
  return new ModalBuilder().setCustomId(customId(NAME, 'done', token)).setTitle(t(lang, 'refinery.done.title'))
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(`**${escapeMarkdown(d.station)}**`))
    .addLabelComponents(textField('yields', t(lang, 'refinery.field.yields'), {
      description: t(lang, 'refinery.field.yieldsHint'), value: d.text, paragraph: true, maxLength: MAX_TEXT,
    }));
}

async function onDoneSubmit(interaction: ModalSubmitInteraction, db: Db, lang: Lang, token: string) {
  const state = getState<DoneDraft>(token, interaction.user.id);
  if (!state.ok) return answerModal(interaction, textPanel(lang, t(lang, 'ui.panelExpired')));
  const d = state.value;
  d.text = interaction.fields.getTextInputValue('yields');
  const parsed = parseDoneText(d.text, d.rows);
  if ('error' in parsed) {
    // The text stays: "Try again" reopens the modal with it
    const container = new ContainerBuilder()
      .addTextDisplayComponents(new TextDisplayBuilder().setContent(`⚠️ ${t(lang, `refinery.done.err.${parsed.error}`, { line: parsed.line ?? 0 })}`))
      .addActionRowComponents(new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId(customId(NAME, 'redo', token)).setLabel(t(lang, 'refinery.btn.retry')).setStyle(ButtonStyle.Primary)));
    return answerModal(interaction, panel(container));
  }
  await book(() => stock.refineDone(db, actorOf(interaction.user.id), {
    jobId: d.jobId,
    // `expected`: the ore quantity shown when the modal opened (a changed job is refused)
    rows: d.rows.map((r, i) => ({ batchId: r.batchId, amount: parsed.amounts[i]!, expected: r.quantity })),
  }));
  getState(token, interaction.user.id, true);
  const lines = d.rows.map((r, i) => `- **${escapeMarkdown(r.name)}** · Q${r.quality} → ${parsed.amounts[i]} ${t(lang, 'unit.scu')}`);
  await answerModal(interaction, textPanel(lang, [t(lang, 'refinery.doneOk', { station: escapeMarkdown(d.station) }), ...lines].join('\n'), true));
}

// --- time left: set later (or cleared) ----------------------------------------------------------

function timeModal(lang: Lang, job: Job): ModalBuilder {
  const left = job.endsAt === null ? null : Math.ceil((new Date(job.endsAt).getTime() - Date.now()) / 1000);
  return new ModalBuilder().setCustomId(customId(NAME, 'time', job.jobId)).setTitle(t(lang, 'refinery.time.title'))
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(`**${escapeMarkdown(job.station)}**`))
    .addLabelComponents(textField('left', t(lang, 'refinery.field.timeLeft'), {
      description: t(lang, 'refinery.field.timeLeftHint'), value: left !== null && left > 0 ? formatDuration(left) : '', required: false, maxLength: 40,
    }));
}

async function onTimeSubmit(interaction: ModalSubmitInteraction, db: Db, lang: Lang, jobId: string) {
  const text = textValue(interaction, 'left');
  // Empty: the end is cleared ("duration open")
  const seconds = text ? parseDuration(text) : null;
  if (text && seconds === null) throw new UserError('refinery.preview.badDuration', { text: codeText(text) });
  const { endsAt } = await book(() => stock.refineSetDuration(db, actorOf(interaction.user.id), { jobId, durationSeconds: seconds }));
  const job = (await ownJobs(db, interaction.user.id, lang)).find((j) => j.jobId === jobId);
  const when = endsAt === null ? t(lang, 'refinery.durationOpen') : t(lang, 'refinery.list.readyAt', { ready: `<t:${unixOf(endsAt)}:R>` });
  await answerModal(interaction, textPanel(lang, t(lang, 'refinery.timeSet', { station: escapeMarkdown(job?.station ?? '?'), when }), true));
}

// --- jobs ---------------------------------------------------------------------------------------

interface Job {
  jobId: string;
  station: string;
  endsAt: string | null;
  batches: PickableBatch[];
}

/** The user's running refinery jobs, the next to be ready first. */
async function ownJobs(db: Db, userId: string, lang: Lang): Promise<Job[]> {
  const jobs = new Map<string, Job>();
  for (const p of await pickableBatches(db, actorOf(userId), 'refining', lang)) {
    const id = p.refine?.jobId;
    if (!id) continue;
    if (!jobs.has(id)) jobs.set(id, { jobId: id, station: p.location, endsAt: p.refine!.endsAt, batches: [] });
    jobs.get(id)!.batches.push(p);
  }
  return [...jobs.values()].sort((a, b) => (a.endsAt ?? '').localeCompare(b.endsAt ?? ''));
}

const isReady = (j: Job, now = Date.now()) => j.endsAt !== null && new Date(j.endsAt).getTime() <= now;

/** "CRU-L1 · Quantanium, Laranite · ready in 2h 10m" for the job option. */
function jobLabel(j: Job, lang: Lang): string {
  const left = j.endsAt === null ? null : Math.ceil((new Date(j.endsAt).getTime() - Date.now()) / 1000);
  const when = left === null ? null : left <= 0 ? t(lang, 'refinery.ready') : t(lang, 'refinery.preview.readyIn', { duration: formatDuration(left) });
  const ores = [...new Set(j.batches.map((b) => b.material))].join(', ');
  const label = [j.station, ores, when].filter(Boolean).join(' · ');
  return label.length > 100 ? `${label.slice(0, 99)}…` : label;
}

function listPanel(lang: Lang, jobs: Job[]) {
  const tr = (key: MessageKey, vars?: Record<string, string | number>) => t(lang, key, vars);
  const blocks = jobs.map((j) => {
    const when = j.endsAt === null ? ` · ${tr('refinery.durationOpen')}` : isReady(j) ? ` · ${tr('refinery.ready')}` : ` · ${tr('refinery.list.readyAt', { ready: `<t:${unixOf(j.endsAt)}:R>` })}`;
    const ores = j.batches.map((p) => {
      const expected = p.refine?.expected == null ? '' : ` → ${formatAmount(p.refine.expected)} ${tr('unit.scu')}`;
      return `- ${escapeMarkdown(p.material)} · Q${p.batch.quality} · ${formatAmount(p.batch.quantity)} ${tr('unit.scu')}${expected}`;
    });
    return [`**${escapeMarkdown(j.station)}**${when}`, ...ores].join('\n');
  });
  let body = '';
  let shown = 0;
  for (const b of blocks) {
    if (body.length + b.length > MAX_PANEL_TEXT) break;
    body += `${body ? '\n\n' : ''}${b}`;
    shown++;
  }
  if (shown < blocks.length) body += `\n\n${tr('refinery.list.more', { count: blocks.length - shown })}`;
  const container = new ContainerBuilder().addTextDisplayComponents(new TextDisplayBuilder().setContent(`### ${tr('refinery.list.title')}`))
    .addSeparatorComponents(new SeparatorBuilder())
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(jobs.length ? body : tr('refinery.list.empty')));
  const web = webAppButton(lang);
  if (web) container.addActionRowComponents(new ActionRowBuilder<ButtonBuilder>().addComponents(web));
  return panel(container);
}

// --- autocomplete --------------------------------------------------------------------------------

async function autocomplete(interaction: AutocompleteInteraction, lang: Lang, db: Db) {
  const focused = interaction.options.getFocused(true);
  const query = String(focused.value);
  if (focused.name === 'station') {
    const refineries = await refineryLocations(db);
    const locations = [...(await locationCatalog(db, lang)).values()].filter((l) => !refineries || refineries.has(l.uuid));
    const found = searchWords(locations, query, (l) => `${l.label} ${l.nameEn}`, (l) => l.name);
    return interaction.respond(found.map((l) => ({ name: l.label.slice(0, 100), value: l.uuid })));
  }
  if (focused.name === 'job') {
    const jobs = await ownJobs(db, interaction.user.id, lang);
    const found = searchWords(jobs.map((j) => ({ j, label: jobLabel(j, lang) })), query, (x) => x.label, (x) => x.j.station);
    return interaction.respond(found.map((x) => ({ name: x.label, value: x.j.jobId })));
  }
  await interaction.respond([]);
}

// --- command -------------------------------------------------------------------------------------

async function start(ctx: CommandContext) {
  const o = ctx.interaction.options;
  const locationUuid = o.getString('station', true);
  const location = (await locationCatalog(ctx.db, ctx.lang)).get(locationUuid);
  if (!location) throw new UserError('stock.err.unknownLocation');
  const refineries = await refineryLocations(ctx.db);
  if (refineries && !refineries.has(locationUuid)) throw new UserError('stock.err.notRefinery');
  const draft: StartDraft = { locationUuid, station: location.short, duration: '', ores: '', ready: null, booking: false };
  const token = putState(ctx.interaction.user.id, draft, CONFIRM_TTL_MS);
  await ctx.showModal(startModal(ctx.lang, token, draft));
}

async function done(ctx: CommandContext) {
  const jobId = ctx.interaction.options.getString('job', true);
  const job = (await ownJobs(ctx.db, ctx.interaction.user.id, ctx.lang)).find((j) => j.jobId === jobId);
  if (!job) throw new UserError('refinery.err.unknownJob');
  const rows = job.batches.map((p) => ({
    batchId: p.batch.id, quantity: p.batch.quantity, name: p.material, quality: p.batch.quality,
    expected: p.refine?.expected == null ? null : formatAmount(p.refine.expected),
  }));
  const draft: DoneDraft = { jobId, station: job.station, rows, text: doneText(rows) };
  const token = putState(ctx.interaction.user.id, draft, CONFIRM_TTL_MS);
  await ctx.showModal(doneModal(ctx.lang, token, draft));
}

async function time(ctx: CommandContext) {
  const jobId = ctx.interaction.options.getString('job', true);
  const job = (await ownJobs(ctx.db, ctx.interaction.user.id, ctx.lang)).find((j) => j.jobId === jobId);
  if (!job) throw new UserError('refinery.err.unknownJob');
  await ctx.showModal(timeModal(ctx.lang, job));
}

export const refineryCommand: BotCommand = {
  data: {
    name: NAME,
    ...localizedDescription('cmd.refinery'),
    contexts: [InteractionContextType.Guild],
    integration_types: [ApplicationIntegrationType.GuildInstall],
    options: [
      opt('start', 'cmd.refinery.start', ApplicationCommandOptionType.Subcommand, {
        options: [
          opt('station', 'refinery.opt.station', S, { required: true, autocomplete: true }),
        ],
      }),
      opt('time', 'cmd.refinery.time', ApplicationCommandOptionType.Subcommand, {
        options: [opt('job', 'refinery.opt.job', S, { required: true, autocomplete: true })],
      }),
      opt('done', 'cmd.refinery.done', ApplicationCommandOptionType.Subcommand, {
        options: [opt('job', 'refinery.opt.job', S, { required: true, autocomplete: true })],
      }),
      opt('list', 'cmd.refinery.list', ApplicationCommandOptionType.Subcommand),
    ],
  },
  modalSubcommands: ['start', 'time', 'done'],
  execute: bySubcommand({
    start,
    time,
    done,
    async list(ctx) {
      await ctx.reply(listPanel(ctx.lang, await ownJobs(ctx.db, ctx.interaction.user.id, ctx.lang)));
    },
  }),
  autocomplete,
  async modal(ctx) {
    const [, action, token] = ctx.interaction.customId.split(':');
    if (action === 'start' && token) return onStartSubmit(ctx.interaction, ctx.db, ctx.lang, token);
    if (action === 'done' && token) return onDoneSubmit(ctx.interaction, ctx.db, ctx.lang, token);
    // The third part is the job ID here (no draft needed)
    if (action === 'time' && token) return onTimeSubmit(ctx.interaction, ctx.db, ctx.lang, token);
    throw new Error(`Unexpected modal ${ctx.interaction.customId}`);
  },
  async component(ctx) {
    const { interaction, lang, db } = ctx;
    const [, action, token] = interaction.customId.split(':');
    if (!token) throw new Error(`Unexpected component ${interaction.customId}`);
    // Panels are ephemeral, so a foreign click is unlikely; refused anyway
    const state = getState<StartDraft & DoneDraft>(token, interaction.user.id);
    if (!state.ok && state.reason === 'foreign') throw new UserError('refinery.err.foreign');
    if (!state.ok) return void await interaction.update(textPanel(lang, t(lang, 'ui.panelExpired')));
    if (action === 'redo') return interaction.showModal(doneModal(lang, token, state.value));
    const d = state.value;
    if (action === 'edit') return interaction.showModal(startModal(lang, token, d));
    if (action === 'cancel') {
      getState(token, interaction.user.id, true);
      return void await interaction.update(textPanel(lang, t(lang, 'refinery.cancelled')));
    }
    if (action !== 'go') throw new Error(`Unexpected component ${interaction.customId}`);
    if (!d.ready) throw new UserError('refinery.err.notReady');
    // A second click while the first one books: acknowledge, do nothing
    if (d.booking) return void await interaction.deferUpdate();
    d.booking = true;
    try {
      await book(() => stock.refineStart(db, actorOf(interaction.user.id), d.ready!));
    } finally {
      d.booking = false;
    }
    getState(token, interaction.user.id, true);
    const seconds = d.ready.durationSeconds;
    const when = seconds === undefined ? t(lang, 'refinery.durationOpen')
      : t(lang, 'refinery.list.readyAt', { ready: `<t:${unixOf(new Date(Date.now() + seconds * 1000).toISOString())}:R>` });
    await interaction.update(textPanel(lang, t(lang, 'refinery.started', {
      station: escapeMarkdown(d.station), count: d.ready.rows.length, amount: sumScu(d.ready.rows.map((r) => r.amount)), when,
    }), true));
  },
};
