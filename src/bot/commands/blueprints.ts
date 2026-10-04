// /qm-bp: the blueprint registry (global per user, visible to the org).
import {
  ActionRowBuilder, ApplicationCommandOptionType, ApplicationIntegrationType, ButtonBuilder, ButtonStyle,
  InteractionContextType, escapeMarkdown, type AutocompleteInteraction,
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

const NAME = 'qm-bp';
const PAGE_SIZE = 20;
const MAX_WHO_NAMES = 60;

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

/** One page of a member's blueprints, grouped by category; groups alphabetical, "other" last. */
export function listPage(entries: BlueprintEntry[], ownerName: string, ownerId: string, page: number, lang: Lang) {
  const tr = (key: MessageKey, vars?: Record<string, string | number>) => t(lang, key, vars);
  const name = escapeMarkdown(ownerName);
  if (!entries.length) return { content: tr('bp.list.empty', { name }), components: [] };
  const other = tr('bp.list.other');
  const group = (e: BlueprintEntry) => e.categoryLabel ?? other;
  const sorted = [...entries].sort((a, b) =>
    Number(group(a) === other) - Number(group(b) === other) || group(a).localeCompare(group(b)) || a.label.localeCompare(b.label));
  const pages = Math.ceil(sorted.length / PAGE_SIZE);
  const current = Math.min(Math.max(page, 0), pages - 1);
  const lines = [tr('bp.list.title', { name, count: sorted.length })];
  let lastGroup: string | null = null;
  for (const e of sorted.slice(current * PAGE_SIZE, (current + 1) * PAGE_SIZE)) {
    // The group header repeats on every page, so each page reads on its own
    if (group(e) !== lastGroup) lines.push(`__${escapeMarkdown(group(e))}__`);
    lastGroup = group(e);
    lines.push(`- ${escapeMarkdown(e.label)}${e.retired ? ` ⚠️ *${tr('bp.list.retired')}*` : ''}`);
  }
  if (pages > 1) lines.push(`-# ${tr('bp.list.page', { page: current + 1, pages })}`);
  const components = pages > 1 ? [new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`${NAME}:list:${ownerId}:${current - 1}`).setLabel('◀')
      .setStyle(ButtonStyle.Secondary).setDisabled(current === 0),
    new ButtonBuilder().setCustomId(`${NAME}:list:${ownerId}:${current + 1}`).setLabel('▶')
      .setStyle(ButtonStyle.Secondary).setDisabled(current === pages - 1),
  )] : [];
  return { content: lines.join('\n'), components };
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
  return { ...listPage(entries, owner?.displayName ?? ownerId, ownerId, page, lang), allowedMentions: { parse: [] } };
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
      const added = await addBlueprint(ctx.db, access.userId, bp.uuid);
      await ctx.reply(ctx.t(added ? 'bp.added' : 'bp.alreadyAdded', { name }));
    },
    async remove(ctx) {
      const access = await requireMember(ctx.db, ctx.interaction);
      const bp = await pickedBlueprint(ctx);
      const removed = await removeBlueprint(ctx.db, access.userId, bp.uuid);
      await ctx.reply(ctx.t(removed ? 'bp.removed' : 'bp.notRegistered', { name: escapeMarkdown(bp.label) }));
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
      const shown = names.slice(0, MAX_WHO_NAMES).map((n) => escapeMarkdown(n)).join(', ');
      const more = names.length > MAX_WHO_NAMES ? `\n${ctx.t('bp.who.more', { count: names.length - MAX_WHO_NAMES })}` : '';
      await ctx.reply(`${ctx.t('bp.who.some', { name, count: names.length })}\n${shown}${more}`);
    },
  }),
  autocomplete,
  async component(ctx) {
    const [, action, ownerId, page] = ctx.interaction.customId.split(':');
    if (action !== 'list' || !ownerId) throw new Error(`Unexpected component ${ctx.interaction.customId}`);
    const access = await requireMember(ctx.db, ctx.interaction);
    await ctx.interaction.update(await memberList(ctx.db, access.guildId, access.userId, ownerId, Number(page) || 0, ctx.lang));
  },
};
