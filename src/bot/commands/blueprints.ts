// /qm-bp: the blueprint registry (global per user, visible to the org). add/remove/who search the
// blueprint as an option; list and who answer as panels.
import {
  ActionRowBuilder, ApplicationCommandOptionType, ApplicationIntegrationType, ButtonBuilder, ButtonStyle, ContainerBuilder,
  InteractionContextType, SeparatorBuilder, TextDisplayBuilder, type AutocompleteInteraction,
} from 'discord.js';
import type { Db } from '../../db/client.ts';
import { requireMember } from '../access.ts';
import {
  addBlueprint, blueprintCatalog, ownedBlueprints, removeBlueprint, rosterEntry, searchBlueprints, whoHas, type BlueprintEntry,
} from '../blueprints.ts';
import { UserError } from '../errors.ts';
import { localizedDescription, t, type Lang, type MessageKey } from '../i18n.ts';
import { bySubcommand, type BotCommand, type CommandContext } from '../registry.ts';
import { accessOf, memberInfo, searchMembers } from '../roster.ts';
import { findGuildSettings } from '../settings.ts';
import { escapeMarkdown } from '../markdown.ts';
import { customId, panel, webAppButton, webAppPath, webAppRow } from '../ui.ts';

const NAME = 'qm-bp';
const PAGE_SIZE = 20;
// Names per page of /qm-bp who
const WHO_PAGE_SIZE = 60;

/**
 * A panel: head, body lines, and (several pages) the page line plus ◀ ▶ buttons whose custom IDs
 * `<action>:<key>:<page>` load that page; the web app link (to `link`, a deep link path) sits in the same row.
 */
function listPanel(lang: Lang, head: string, body: string[], paging: { action: string; key: string; current: number; pages: number } | null, link: string) {
  const container = new ContainerBuilder().addTextDisplayComponents(new TextDisplayBuilder().setContent(head));
  if (body.length) {
    container.addSeparatorComponents(new SeparatorBuilder())
      .addTextDisplayComponents(new TextDisplayBuilder().setContent(body.join('\n')));
  }
  const buttons: ButtonBuilder[] = [];
  if (paging && paging.pages > 1) {
    const { action, key, current, pages } = paging;
    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(`-# ${t(lang, 'bp.list.page', { page: current + 1, pages })}`));
    buttons.push(
      new ButtonBuilder().setCustomId(customId(NAME, action, key, current - 1)).setLabel('◀')
        .setStyle(ButtonStyle.Secondary).setDisabled(current === 0),
      new ButtonBuilder().setCustomId(customId(NAME, action, key, current + 1)).setLabel('▶')
        .setStyle(ButtonStyle.Secondary).setDisabled(current === pages - 1),
    );
  }
  const web = webAppButton(lang, link);
  if (web) buttons.push(web);
  if (buttons.length) {
    container.addSeparatorComponents(new SeparatorBuilder())
      .addActionRowComponents(new ActionRowBuilder<ButtonBuilder>().addComponents(buttons));
  }
  return panel(container);
}

const pageOf = (count: number, size: number, page: number) => {
  const pages = Math.max(Math.ceil(count / size), 1);
  return { pages, current: Math.min(Math.max(page, 0), pages - 1) };
};

const blueprintOption = {
  name: 'blueprint', ...localizedDescription('opt.blueprint'),
  type: ApplicationCommandOptionType.String, required: true, autocomplete: true,
} as const;

/** The catalog entry behind an autocomplete value (a UUID); free text that was not picked is refused. */
async function pickedBlueprint(ctx: CommandContext): Promise<BlueprintEntry> {
  const value = ctx.interaction.options.getString('blueprint', true);
  const entry = (await blueprintCatalog(ctx.db, ctx.lang)).byUuid.get(value);
  if (!entry) throw new UserError('bp.unknown');
  return entry;
}

/** One page of a member's blueprints as a panel, grouped by category; groups alphabetical, "other" last. */
export function listPage(entries: BlueprintEntry[], ownerName: string, ownerId: string, page: number, lang: Lang, link: string) {
  const tr = (key: MessageKey, vars?: Record<string, string | number>) => t(lang, key, vars);
  const name = escapeMarkdown(ownerName);
  if (!entries.length) return listPanel(lang, tr('bp.list.empty', { name }), [], null, link);
  const other = tr('bp.list.other');
  const group = (e: BlueprintEntry) => e.categoryLabel ?? other;
  const sorted = [...entries].sort((a, b) =>
    Number(group(a) === other) - Number(group(b) === other) || group(a).localeCompare(group(b)) || a.label.localeCompare(b.label));
  const { pages, current } = pageOf(sorted.length, PAGE_SIZE, page);
  const lines: string[] = [];
  let lastGroup: string | null = null;
  for (const e of sorted.slice(current * PAGE_SIZE, (current + 1) * PAGE_SIZE)) {
    // The group header repeats on every page, so each page reads on its own
    if (group(e) !== lastGroup) lines.push(`__${escapeMarkdown(group(e))}__`);
    lastGroup = group(e);
    lines.push(`- ${escapeMarkdown(e.label)}${e.retired ? ` ⚠️ *${tr('bp.list.retired')}*` : ''}`);
  }
  return listPanel(lang, tr('bp.list.title', { name, count: sorted.length }), lines, { action: 'list', key: ownerId, current, pages }, link);
}

/** One page of the org members who registered a blueprint (names alphabetical), as a panel; links to its crafting check. */
export function whoPage(names: string[], bp: Pick<BlueprintEntry, 'uuid' | 'label'>, page: number, lang: Lang) {
  const { pages, current } = pageOf(names.length, WHO_PAGE_SIZE, page);
  const shown = names.slice(current * WHO_PAGE_SIZE, (current + 1) * WHO_PAGE_SIZE).map((n) => escapeMarkdown(n)).join(', ');
  return listPanel(lang, t(lang, 'bp.who.some', { name: escapeMarkdown(bp.label), count: names.length }), [shown],
    { action: 'who', key: bp.uuid, current, pages }, webAppPath.crafting(bp.uuid));
}

/** The list for an org member; other people only while they are active members of this org. */
async function memberList(db: Db, guildId: string, callerId: string, ownerId: string, page: number, lang: Lang, fallbackName = ownerId) {
  const owner = await rosterEntry(db, guildId, ownerId);
  if (ownerId !== callerId && !owner?.active) {
    throw new UserError('bp.list.notMember', { name: escapeMarkdown(owner?.displayName ?? fallbackName) });
  }
  const catalog = await blueprintCatalog(db, lang);
  const owned = await ownedBlueprints(db, ownerId);
  const entries = [...owned].map((uuid) => catalog.byUuid.get(uuid)).filter((e): e is BlueprintEntry => !!e);
  // Your own list: your blueprints in the web app; someone else's: the org's (with who has which)
  const link = webAppPath.blueprints(ownerId === callerId ? 'personal' : guildId);
  return listPage(entries, owner?.displayName ?? ownerId, ownerId, page, lang, link);
}

async function autocomplete(interaction: AutocompleteInteraction, lang: Lang, db: Db) {
  // No roster writes here (autocomplete must answer fast); non-members just get no suggestions
  const settings = interaction.inGuild() ? await findGuildSettings(db, interaction.guildId) : null;
  if (!settings || !interaction.member || !accessOf(memberInfo(interaction.member).roleIds, settings).member) {
    return interaction.respond([]);
  }
  const focused = interaction.options.getFocused(true);
  if (focused.name === 'member') {
    const found = await searchMembers(db, interaction.guildId!, String(focused.value));
    return interaction.respond(found.map((m) => ({
      name: (m.rsiHandle ? `${m.displayName} · ${m.rsiHandle}` : m.displayName).slice(0, 100), value: m.userId,
    })));
  }
  const sub = interaction.options.getSubcommand();
  const { entries } = await blueprintCatalog(db, lang);
  const owned = sub === 'who' ? null : await ownedBlueprints(db, interaction.user.id);
  const candidates = entries.filter((e) => {
    if (sub === 'add') return !e.isDefault && !e.retired && !owned!.has(e.uuid);
    if (sub === 'remove') return owned!.has(e.uuid);
    return !e.retired;
  });
  const found = searchBlueprints(candidates, String(focused.value));
  await interaction.respond(found.map((e) => ({ name: e.label, value: e.uuid })));
}

export const blueprintsCommand: BotCommand = {
  data: {
    name: NAME,
    ...localizedDescription('cmd.bp'),
    contexts: [InteractionContextType.Guild],
    integration_types: [ApplicationIntegrationType.GuildInstall],
    options: [
      { name: 'add', ...localizedDescription('cmd.bp.add'), type: ApplicationCommandOptionType.Subcommand, options: [blueprintOption] },
      { name: 'remove', ...localizedDescription('cmd.bp.remove'), type: ApplicationCommandOptionType.Subcommand, options: [blueprintOption] },
      {
        name: 'list', ...localizedDescription('cmd.bp.list'), type: ApplicationCommandOptionType.Subcommand,
        // A string with autocomplete over active org members (Discord's user picker offers everyone on the server)
        options: [{ name: 'member', ...localizedDescription('opt.member'), type: ApplicationCommandOptionType.String, autocomplete: true }],
      },
      { name: 'who', ...localizedDescription('cmd.bp.who'), type: ApplicationCommandOptionType.Subcommand, options: [blueprintOption] },
    ],
  },
  execute: bySubcommand({
    async add(ctx) {
      const access = await requireMember(ctx.db, ctx.interaction);
      const bp = await pickedBlueprint(ctx);
      const name = escapeMarkdown(bp.label);
      if (bp.isDefault) throw new UserError('bp.default', { name });
      if (bp.retired) throw new UserError('bp.retired', { name });
      const added = await addBlueprint(ctx.db, access.userId, bp.uuid, 'bot');
      await ctx.reply({ content: ctx.t(added ? 'bp.added' : 'bp.alreadyAdded', { name }), components: webAppRow(ctx.lang, webAppPath.crafting(bp.uuid)) });
    },
    async remove(ctx) {
      const access = await requireMember(ctx.db, ctx.interaction);
      const bp = await pickedBlueprint(ctx);
      const removed = await removeBlueprint(ctx.db, access.userId, bp.uuid, 'bot');
      await ctx.reply({ content: ctx.t(removed ? 'bp.removed' : 'bp.notRegistered', { name: escapeMarkdown(bp.label) }), components: webAppRow(ctx.lang, webAppPath.blueprints('personal')) });
    },
    async list(ctx) {
      const access = await requireMember(ctx.db, ctx.interaction);
      // The value is a user ID when picked from the suggestions; anything else is not an active member
      const picked = ctx.interaction.options.getString('member');
      const ownerId = picked ?? access.userId;
      await ctx.reply(await memberList(ctx.db, access.guildId, access.userId, ownerId, 0, ctx.lang, picked ?? undefined));
    },
    async who(ctx) {
      const access = await requireMember(ctx.db, ctx.interaction);
      const bp = await pickedBlueprint(ctx);
      const name = escapeMarkdown(bp.label);
      if (bp.isDefault) return ctx.reply(ctx.t('bp.who.default', { name }));
      const names = await whoHas(ctx.db, access.guildId, bp.uuid);
      if (!names.length) return ctx.reply(ctx.t('bp.who.none', { name }));
      await ctx.reply(whoPage(names, bp, 0, ctx.lang));
    },
  }),
  autocomplete,
  async component(ctx) {
    const [, action, key, page] = ctx.interaction.customId.split(':');
    if ((action !== 'list' && action !== 'who') || !key) throw new Error(`Unexpected component ${ctx.interaction.customId}`);
    const access = await requireMember(ctx.db, ctx.interaction);
    if (action === 'list') {
      await ctx.interaction.update(await memberList(ctx.db, access.guildId, access.userId, key, Number(page) || 0, ctx.lang));
      return;
    }
    const bp = (await blueprintCatalog(ctx.db, ctx.lang)).byUuid.get(key);
    if (!bp) throw new UserError('bp.unknown');
    const names = await whoHas(ctx.db, access.guildId, bp.uuid);
    // Everyone may have removed it since the panel was shown
    if (!names.length) {
      await ctx.interaction.update(listPanel(ctx.lang, ctx.t('bp.who.none', { name: escapeMarkdown(bp.label) }), [], null, webAppPath.crafting(bp.uuid)));
      return;
    }
    await ctx.interaction.update(whoPage(names, bp, Number(page) || 0, ctx.lang));
  },
};
