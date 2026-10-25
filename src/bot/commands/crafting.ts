// /qm-crafting: the web app's crafting check for one blueprint. The option searches the blueprint, a
// modal asks for the count and one material quality for every slot, a panel shows what it needs, what
// your stock (yours and what is shared in your orgs) covers and the stat changes. No org needed.
import {
  ActionRowBuilder, ApplicationCommandOptionType, ApplicationIntegrationType, ButtonBuilder, ButtonStyle, ContainerBuilder,
  InteractionContextType, MessageFlags, ModalBuilder, SeparatorBuilder, TextDisplayBuilder, type AutocompleteInteraction,
} from 'discord.js';
import type { Db } from '../../db/client.ts';
import { loadPlannerData } from '../../planner/load.ts';
import { computePlan } from '../../planner/plan.ts';
import { coverageOf, MAX_COUNT, MIN_COUNT, needsOf, withQualityFloor, type CoverBatch, type Coverage } from '../../planner/stock.ts';
import type { EntryResult, PlannerRecipe, PlanWarning, StatResult } from '../../planner/types.ts';
import { formatAmount } from '../../stock/amount.ts';
import { stockList, type PickableBatch } from '../../stock/lookup.ts';
import { qMark } from '../../stock/quality.ts';
import { blueprintCatalog, searchBlueprints, type BlueprintEntry } from '../blueprints.ts';
import { UserError } from '../errors.ts';
import { localizedDescription, t, type Lang } from '../i18n.ts';
import { escapeMarkdown } from '../markdown.ts';
import { formatDuration } from '../refinery-lines.ts';
import type { BotCommand } from '../registry.ts';
import { addHead, thumbUrl } from '../thumbs.ts';
import { customId, panel, textField, textValue, webAppButton, webAppPath } from '../ui.ts';
import { parseQuality } from './stock.ts';

const NAME = 'qm-crafting';
// Custom ID part for "no quality typed" (the game's default)
const DEFAULT_Q = '-';

/** The count as typed: whole crafts, 1–99. */
export function parseCount(text: string): number | null {
  if (!/^\d{1,2}$/.test(text.trim())) return null;
  const n = Number(text);
  return n >= MIN_COUNT && n <= MAX_COUNT ? n : null;
}

function checkModal(lang: Lang, bp: Pick<BlueprintEntry, 'uuid' | 'label'>, count: number, quality: number | null): ModalBuilder {
  return new ModalBuilder().setCustomId(customId(NAME, 'check', bp.uuid)).setTitle(t(lang, 'crafting.modal.title'))
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(`**${escapeMarkdown(bp.label)}**`))
    .addLabelComponents(
      textField('count', t(lang, 'crafting.field.count'), { value: String(count), description: t(lang, 'crafting.field.countHint'), maxLength: 2 }),
      textField('quality', t(lang, 'crafting.field.quality'), {
        value: quality === null ? '' : String(quality), description: t(lang, 'crafting.field.qualityHint'), required: false, maxLength: 4,
      }),
    );
}

/** What the check reads of a batch. */
const coverBatch = (p: PickableBatch): CoverBatch => ({
  kind: p.batch.kind,
  subjectUuid: p.batch.resourceUuid ?? p.batch.itemUuid!,
  location: p.location,
  state: p.batch.state,
  quality: p.batch.quality,
  quantity: formatAmount(p.batch.quantity),
  holderUserId: p.batch.ownerUserId,
});

/** A planner warning in the user's language. */
function warningText(lang: Lang, w: PlanWarning): string {
  switch (w.code) {
    case 'slots': return t(lang, 'crafting.warn.slots', { n: w.required, m: w.total });
    case 'retired': return t(lang, 'crafting.warn.retired');
    case 'alternatives': return t(lang, 'crafting.warn.alternatives', { slot: escapeMarkdown(w.slot) });
    case 'belowMin': return t(lang, 'crafting.warn.belowMin', { q: w.quality, slot: escapeMarkdown(w.slot) });
    case 'unsupported': return t(lang, 'crafting.warn.unsupported', { stat: escapeMarkdown(w.stat), slot: escapeMarkdown(w.slot) });
  }
}

/** "+5.0%" for a multiplier, "+2" for integer steps (as the web app shows them). */
function statText(s: StatResult): string {
  if (s.kind === 'additive') return `${s.value >= 0 ? '+' : ''}${s.value}`;
  const pct = (s.value - 1) * 100;
  return `${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%`;
}

const statMark = (s: StatResult) => (s.favorable === null ? '⚪' : s.favorable ? '🟢' : '🔴');

export interface CheckView {
  // outputUuid: the crafted item, its thumbnail beside the head
  bp: Pick<BlueprintEntry, 'uuid' | 'label'> & { outputUuid?: string | null };
  recipe: PlannerRecipe;
  result: EntryResult;
  coverages: Coverage[];
  // As typed; null = the game's default
  quality: number | null;
  defaultQuality: number;
}

/** The check as a panel: head (with the crafted item's thumbnail), materials against the stock, stats, warnings; "Change" reopens the modal. */
export function checkPanel(lang: Lang, v: CheckView) {
  const tr = (key: Parameters<typeof t>[1], vars?: Parameters<typeof t>[2]) => t(lang, key, vars);
  const { recipe, result } = v;
  const meta = [
    recipe.categoryLabel,
    recipe.outputTypeLabel && (recipe.outputSubTypeLabel ? `${recipe.outputTypeLabel} / ${recipe.outputSubTypeLabel}` : recipe.outputTypeLabel),
    recipe.isDefault ? tr('crafting.default') : null,
    recipe.retired ? `⚠️ ${tr('bp.list.retired')}` : null,
  ].filter((x): x is string => !!x).map(escapeMarkdown);
  const quality = v.quality ?? v.defaultQuality;
  const head = [
    tr('crafting.title', { name: escapeMarkdown(v.bp.label), count: result.count }),
    ...(meta.length ? [`-# ${meta.join(' · ')}`] : []),
    tr(v.quality === null ? 'crafting.summaryDefault' : 'crafting.summary', { quality, time: formatDuration(Math.round(result.craftSeconds)) }),
  ];

  const unit = (kind: string) => tr(kind === 'item' ? 'unit.pcs' : 'unit.scu');
  const materials = v.coverages.map((c) => `- **${escapeMarkdown(c.need.name)}** · ${formatAmount(c.need.total)} ${unit(c.need.kind)}`
    + ` · Q ≥ ${c.need.quality} ${qMark(c.need.quality)} · `
    + (c.covered ? `✅ ${tr('crafting.covered')}` : `❌ ${tr('crafting.lacking', { amount: `**${formatAmount(c.missing)} ${unit(c.need.kind)}**` })}`));
  const body = [tr('crafting.materials'), ...(materials.length ? materials : ['—'])];
  if (recipe.requiredSlots < recipe.slots.length) body.push(`-# ${tr('crafting.slotsOf', { n: recipe.requiredSlots, m: recipe.slots.length })}`);
  if (result.stats.length) {
    body.push(tr('crafting.stats'), ...result.stats.map((s) => `- ${statMark(s)} ${escapeMarkdown(s.name)}: **${statText(s)}**`));
  }
  // The quality floor keeps belowMin away; the retired head tag says that already
  const warnings = result.warnings.filter((w) => w.code !== 'retired').map((w) => `⚠️ ${warningText(lang, w)}`);

  const container = addHead(new ContainerBuilder(), head.join('\n'), thumbUrl(v.bp.outputUuid))
    .addSeparatorComponents(new SeparatorBuilder())
    .addTextDisplayComponents(new TextDisplayBuilder().setContent([...body, ...warnings].join('\n')));
  const buttons = [new ButtonBuilder().setCustomId(customId(NAME, 'edit', v.bp.uuid, result.count, v.quality ?? DEFAULT_Q))
    .setLabel(tr('crafting.btn.edit')).setStyle(ButtonStyle.Secondary)];
  const web = webAppButton(lang, webAppPath.crafting(v.bp.uuid));
  if (web) buttons.push(web);
  container.addSeparatorComponents(new SeparatorBuilder())
    .addActionRowComponents(new ActionRowBuilder<ButtonBuilder>().addComponents(buttons));
  return panel(container);
}

/** Runs the check for a user: the blueprint's recipe at the count and quality, against the stock they can see. */
export async function checkReply(db: Db, lang: Lang, userId: string, uuid: string, count: number, quality: number | null) {
  const bp = (await blueprintCatalog(db, lang)).byUuid.get(uuid);
  const data = await loadPlannerData(db, [uuid], lang);
  const recipe = data.recipes[0];
  if (!bp || !recipe) throw new UserError('bp.unknown');
  const typed = quality === null ? undefined : Object.fromEntries(recipe.slots.map((s) => [s.index, quality]));
  const result = computePlan(data, [withQualityFloor(data, { blueprintUuid: uuid, count, quality: typed })]).entries[0]!;
  const stock = (await stockList(db, { scope: { allOf: userId } }, lang)).map(coverBatch);
  const coverages = needsOf(result).map((n) => coverageOf(n, stock, userId));
  return checkPanel(lang, { bp, recipe, result, coverages, quality, defaultQuality: data.defaultQuality });
}

async function autocomplete(interaction: AutocompleteInteraction, lang: Lang, db: Db) {
  const { entries } = await blueprintCatalog(db, lang);
  const found = searchBlueprints(entries.filter((e) => !e.retired), String(interaction.options.getFocused()));
  await interaction.respond(found.map((e) => ({ name: e.label, value: e.uuid })));
}

export const craftingCommand: BotCommand = {
  data: {
    name: NAME,
    ...localizedDescription('cmd.crafting'),
    contexts: [InteractionContextType.Guild],
    integration_types: [ApplicationIntegrationType.GuildInstall],
    options: [{
      name: 'blueprint', ...localizedDescription('opt.blueprint'),
      type: ApplicationCommandOptionType.String, required: true, autocomplete: true,
    }],
  },
  autocomplete,
  // Before the modal only the cached catalog is read
  modalSubcommands: [''],
  async execute(ctx) {
    const bp = (await blueprintCatalog(ctx.db, ctx.lang)).byUuid.get(ctx.interaction.options.getString('blueprint', true));
    if (!bp) throw new UserError('bp.unknown');
    await ctx.showModal(checkModal(ctx.lang, bp, MIN_COUNT, null));
  },
  async modal(ctx) {
    const { interaction } = ctx;
    const [, action, uuid] = interaction.customId.split(':');
    if (action !== 'check' || !uuid) throw new Error(`Unexpected modal ${interaction.customId}`);
    const count = parseCount(textValue(interaction, 'count'));
    if (count === null) throw new UserError('crafting.err.count');
    const typed = textValue(interaction, 'quality');
    const quality = typed ? parseQuality(typed) : null;
    if (typed && quality === null) throw new UserError('stock.err.invalidQuality');
    // Opened from a panel's "Change": redraw that panel
    if (interaction.isFromMessage()) await interaction.deferUpdate();
    else await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    await interaction.editReply(await checkReply(ctx.db, ctx.lang, interaction.user.id, uuid, count, quality));
  },
  async component(ctx) {
    const [, action, uuid, count, quality] = ctx.interaction.customId.split(':');
    if (action !== 'edit' || !uuid) throw new Error(`Unexpected component ${ctx.interaction.customId}`);
    const bp = (await blueprintCatalog(ctx.db, ctx.lang)).byUuid.get(uuid);
    if (!bp) throw new UserError('bp.unknown');
    await ctx.interaction.showModal(checkModal(ctx.lang, bp, parseCount(count ?? '') ?? MIN_COUNT, quality === DEFAULT_Q ? null : parseQuality(quality ?? '')));
  },
};
