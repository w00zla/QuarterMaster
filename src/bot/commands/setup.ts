// /qm-setup: an ephemeral panel (Components V2) with one select per setting; every selection is saved
// at once and the panel is redrawn. Admins only (Manage Server), checked again on every selection.
import {
  ActionRowBuilder, ApplicationIntegrationType, ButtonBuilder, ButtonStyle, ChannelSelectMenuBuilder, ChannelType, ContainerBuilder,
  InteractionContextType, MessageFlags, ModalBuilder, PermissionFlagsBits, RoleSelectMenuBuilder, SeparatorBuilder, StringSelectMenuBuilder,
  TextDisplayBuilder, type Guild, type MessageActionRowComponentBuilder, type PermissionsBitField,
} from 'discord.js';
import { UserError } from '../errors.ts';
import { localizedDescription, t, type Lang, type MessageKey } from '../i18n.ts';
import type { BotCommand } from '../registry.ts';
import { BOARD_STYLES, requestBoardUpdate, type BoardStyle } from '../board.ts';
import { requestFullSync } from '../roster-keeper.ts';
import { ensureGuild, LOGS_LEVELS, updateGuildSettings, type GuildSettings } from '../settings.ts';
import { panel, textField, textValue } from '../ui.ts';

const NAME = 'qm-setup';
const LANGS: Lang[] = ['en', 'de'];

// What the bot needs in the logs channel (Attach Files for later file exports)
const LOGS_PERMISSIONS: [bigint, MessageKey][] = [
  [PermissionFlagsBits.ViewChannel, 'perm.viewChannel'],
  [PermissionFlagsBits.SendMessages, 'perm.sendMessages'],
  [PermissionFlagsBits.EmbedLinks, 'perm.embedLinks'],
  [PermissionFlagsBits.AttachFiles, 'perm.attachFiles'],
];

/** null = no channel set; 'unknown' = channel or bot member not in the cache. */
export type ChannelCheck = null | 'unknown' | { missing: MessageKey[] };

export function missingLogsPermissions(perms: Readonly<PermissionsBitField>): MessageKey[] {
  return LOGS_PERMISSIONS.filter(([flag]) => !perms.has(flag)).map(([, key]) => key);
}

// What the bot needs in the board channel: post its message and edit it
const BOARD_PERMISSIONS: [bigint, MessageKey][] = [
  [PermissionFlagsBits.ViewChannel, 'perm.viewChannel'],
  [PermissionFlagsBits.SendMessages, 'perm.sendMessages'],
];

export function missingBoardPermissions(perms: Readonly<PermissionsBitField>): MessageKey[] {
  return BOARD_PERMISSIONS.filter(([flag]) => !perms.has(flag)).map(([, key]) => key);
}

function checkChannel(guild: Guild | null, channelId: string | null, missing: (perms: Readonly<PermissionsBitField>) => MessageKey[]): ChannelCheck {
  if (!channelId) return null;
  const channel = guild?.channels.cache.get(channelId);
  const me = guild?.members.me;
  const perms = channel && me ? channel.permissionsFor(me) : null;
  return perms ? { missing: missing(perms) } : 'unknown';
}

const checks = (guild: Guild | null, s: GuildSettings) => ({
  logs: checkChannel(guild, s.logsChannelId, missingLogsPermissions),
  board: checkChannel(guild, s.boardChannelId, missingBoardPermissions),
});

/**
 * The panel: one section per area (heading, current value, its selects), separated by lines (a V2 container:
 * more than the 5 rows of a plain message).
 */
export function setupPanel(s: GuildSettings, lang: Lang, check: { logs: ChannelCheck; board: ChannelCheck }) {
  const tr = (key: MessageKey, vars?: Record<string, string>) => t(lang, key, vars);
  const status = (c: ChannelCheck) => (c === 'unknown' || c === null
    ? `⚠️ ${tr('setup.perms.unknown')}`
    : c.missing.length
      ? `⚠️ ${tr('setup.perms.missing', { perms: c.missing.map((k) => tr(k)).join(', ') })}`
      : `✅ ${tr('setup.perms.ok')}`);
  // The selects show the settings; the text adds only what they cannot: what an area is for, the channel checks
  const section = (heading: MessageKey, ...lines: (string | false)[]) => [tr(heading), ...lines].filter(Boolean).join('\n');

  const row = (component: MessageActionRowComponentBuilder) =>
    new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(component);
  const roleSelect = (id: string, placeholder: MessageKey, selected: string[]) =>
    new RoleSelectMenuBuilder().setCustomId(`${NAME}:${id}`).setPlaceholder(tr(placeholder))
      .setMinValues(0).setMaxValues(25).setDefaultRoles(...selected);
  const sections: [string, ActionRowBuilder<MessageActionRowComponentBuilder>[]][] = [
    [section('setup.section.members'), [
      row(roleSelect('memberRoles', 'setup.pick.memberRoles', s.memberRoleIds)),
    ]],
    [section('setup.section.lang', `-# ${tr('setup.baseLang')}`), [
      row(new StringSelectMenuBuilder().setCustomId(`${NAME}:baseLang`).setPlaceholder(tr('setup.pick.baseLang'))
        .addOptions(LANGS.map((l) => ({ label: tr(`setup.lang.${l}`), value: l, default: l === s.baseLang })))),
    ]],
    [section('setup.section.logs', `-# ${tr('setup.logsInfo')}`, !!s.logsChannelId && status(check.logs)), [
      row(new ChannelSelectMenuBuilder().setCustomId(`${NAME}:logsChannel`).setPlaceholder(tr('setup.pick.logsChannel'))
        .setChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
        .setMinValues(0).setMaxValues(1).setDefaultChannels(...(s.logsChannelId ? [s.logsChannelId] : []))),
      row(new StringSelectMenuBuilder().setCustomId(`${NAME}:logsLevel`).setPlaceholder(tr('setup.pick.logsLevel'))
        // The select shows only the chosen label, so it names what it is about
        .addOptions(LOGS_LEVELS.map((l) => ({ label: `${tr('setup.logs')}: ${tr(`setup.level.${l}`)}`, value: l, default: l === s.logsLevel })))),
    ]],
    [section('setup.section.board', `-# ${tr('setup.boardInfo')}`, !!s.boardChannelId && status(check.board)), [
      row(new ChannelSelectMenuBuilder().setCustomId(`${NAME}:boardChannel`).setPlaceholder(tr('setup.pick.boardChannel'))
        .setChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
        .setMinValues(0).setMaxValues(1).setDefaultChannels(...(s.boardChannelId ? [s.boardChannelId] : []))),
      row(new StringSelectMenuBuilder().setCustomId(`${NAME}:boardStyle`).setPlaceholder(tr('setup.pick.boardStyle'))
        .addOptions(BOARD_STYLES.map((v) => ({ label: `${tr('setup.board')}: ${tr(`setup.style.${v}`)}`, value: v, default: v === s.boardStyle })))),
      // The title is typed: a modal
      row(new ButtonBuilder().setCustomId(`${NAME}:boardTitle`).setLabel(tr('setup.btn.boardTitle')).setEmoji('✏️').setStyle(ButtonStyle.Secondary)),
    ]],
  ];
  const container = new ContainerBuilder()
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(`${tr('setup.title')}\n-# ${tr('setup.saved')}`));
  for (const [text, rows] of sections) {
    container.addSeparatorComponents(new SeparatorBuilder())
      .addTextDisplayComponents(new TextDisplayBuilder().setContent(text))
      .addActionRowComponents(rows);
  }
  // Role and channel mentions render but must never ping (panel sets allowedMentions)
  return panel(container);
}

// Discord's limit for a text input is 4000; a board title stays short (the DB allows 100)
const TITLE_MAX = 100;

/** The modal for the board's title and subtitle, prefilled with the current ones. */
export function boardTitleModal(s: GuildSettings, lang: Lang): ModalBuilder {
  return new ModalBuilder().setCustomId(`${NAME}:boardTitle`).setTitle(t(lang, 'setup.btn.boardTitle')).addLabelComponents(
    textField('title', t(lang, 'setup.field.boardTitle'), {
      description: t(lang, 'setup.field.boardTitleHint'), value: s.boardTitle ?? '', required: false, maxLength: TITLE_MAX,
    }),
    textField('subtitle', t(lang, 'setup.field.boardSubtitle'), {
      description: t(lang, 'setup.field.boardSubtitleHint'), value: s.boardSubtitle ?? '', required: false, maxLength: TITLE_MAX,
    }),
  );
}

function requireManageGuild(perms: Readonly<PermissionsBitField> | null) {
  if (!perms?.has(PermissionFlagsBits.ManageGuild)) throw new UserError('error.manageGuild');
}

/** The settings change one selection stands for; null for an unknown or invalid value. */
export function patchFor(field: string, values: string[]): Partial<GuildSettings> | null {
  switch (field) {
    case 'memberRoles': return { memberRoleIds: values };
    case 'baseLang': return LANGS.includes(values[0] as Lang) ? { baseLang: values[0] as Lang } : null;
    case 'logsChannel': return { logsChannelId: values[0] ?? null };
    case 'boardChannel': return { boardChannelId: values[0] ?? null };
    case 'boardStyle': return (BOARD_STYLES as readonly string[]).includes(values[0] ?? '') ? { boardStyle: values[0] as BoardStyle } : null;
    case 'logsLevel': return (LOGS_LEVELS as readonly string[]).includes(values[0] ?? '') ? { logsLevel: values[0] as GuildSettings['logsLevel'] } : null;
    default: return null;
  }
}

export const setupCommand: BotCommand = {
  data: {
    name: NAME,
    ...localizedDescription('cmd.setup'),
    // Hidden for everyone without Manage Server (server admins can change that; the handlers check anyway)
    default_member_permissions: PermissionFlagsBits.ManageGuild.toString(),
    contexts: [InteractionContextType.Guild],
    integration_types: [ApplicationIntegrationType.GuildInstall],
  },
  async execute(ctx) {
    const { interaction } = ctx;
    if (!interaction.inGuild()) throw new UserError('error.guildOnly');
    requireManageGuild(interaction.memberPermissions);
    const settings = await ensureGuild(ctx.db, interaction.guildId, interaction.guild?.name ?? interaction.guildId);
    await ctx.reply(setupPanel(settings, ctx.lang, checks(interaction.guild, settings)));
  },
  async component(ctx) {
    const { interaction } = ctx;
    if (!interaction.inGuild()) throw new UserError('error.guildOnly');
    requireManageGuild(interaction.memberPermissions);
    const field = interaction.customId.slice(NAME.length + 1);
    // A modal must be the first answer: one row read before it
    if (interaction.isButton() && field === 'boardTitle') {
      const settings = await ensureGuild(ctx.db, interaction.guildId, interaction.guild?.name ?? interaction.guildId);
      await interaction.showModal(boardTitleModal(settings, ctx.lang));
      return;
    }
    const patch = interaction.isAnySelectMenu() ? patchFor(field, interaction.values) : null;
    if (!patch) throw new Error(`Unexpected setup component ${interaction.customId}`);
    // The panel may outlive a database reset: make sure the rows exist before updating them
    await ensureGuild(ctx.db, interaction.guildId, interaction.guild?.name ?? interaction.guildId);
    const settings = await updateGuildSettings(ctx.db, interaction.guildId, patch);
    await interaction.update(setupPanel(settings, ctx.lang, checks(interaction.guild, settings)));
    // The board's language, channel or style: render it again (its data did not change)
    if (patch.baseLang !== undefined || patch.boardChannelId !== undefined || patch.boardStyle !== undefined) requestBoardUpdate(interaction.guildId);
    // Different roles mean a different roster (after the update: a large server takes a while)
    if (patch.memberRoleIds && interaction.guild) requestFullSync(interaction.guild);
  },
  async modal(ctx) {
    const { interaction } = ctx;
    if (!interaction.inGuild()) throw new UserError('error.guildOnly');
    requireManageGuild(interaction.memberPermissions);
    if (interaction.customId !== `${NAME}:boardTitle`) throw new Error(`Unexpected setup modal ${interaction.customId}`);
    // Empty = the org name; Discord caps the length, the slice keeps the DB check safe anyway
    const boardTitle = textValue(interaction, 'title').slice(0, TITLE_MAX) || null;
    const boardSubtitle = textValue(interaction, 'subtitle').slice(0, TITLE_MAX) || null;
    await ensureGuild(ctx.db, interaction.guildId, interaction.guild?.name ?? interaction.guildId);
    const settings = await updateGuildSettings(ctx.db, interaction.guildId, { boardTitle, boardSubtitle });
    const next = setupPanel(settings, ctx.lang, checks(interaction.guild, settings));
    // Opened from the panel's button: redraw the panel
    if (interaction.isFromMessage()) await interaction.update(next);
    else await interaction.reply({ ...next, flags: next.flags | MessageFlags.Ephemeral });
    requestBoardUpdate(interaction.guildId);
  },
};
