// /qm-setup: an ephemeral panel with one select per setting; every selection is saved at once
// and the panel is redrawn. Admins only (Manage Server), checked again on every selection.
import {
  ActionRowBuilder, ApplicationIntegrationType, ChannelSelectMenuBuilder, ChannelType, InteractionContextType,
  PermissionFlagsBits, RoleSelectMenuBuilder, StringSelectMenuBuilder,
  type Guild, type MessageActionRowComponentBuilder, type PermissionsBitField,
} from 'discord.js';
import { UserError } from '../errors.ts';
import { localizedDescription, t, type Lang, type MessageKey } from '../i18n.ts';
import type { BotCommand } from '../registry.ts';
import { ensureGuild, LOGS_LEVELS, updateGuildSettings, type GuildSettings } from '../settings.ts';

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
export type LogsCheck = null | 'unknown' | { missing: MessageKey[] };

export function missingLogsPermissions(perms: Readonly<PermissionsBitField>): MessageKey[] {
  return LOGS_PERMISSIONS.filter(([flag]) => !perms.has(flag)).map(([, key]) => key);
}

function checkLogsChannel(guild: Guild | null, channelId: string | null): LogsCheck {
  if (!channelId) return null;
  const channel = guild?.channels.cache.get(channelId);
  const me = guild?.members.me;
  const perms = channel && me ? channel.permissionsFor(me) : null;
  return perms ? { missing: missingLogsPermissions(perms) } : 'unknown';
}

/** The panel: current values as text, one select per setting (5 rows, Discord's maximum). */
export function setupPanel(s: GuildSettings, lang: Lang, logs: LogsCheck) {
  const tr = (key: MessageKey, vars?: Record<string, string>) => t(lang, key, vars);
  const roles = (ids: string[]) => (ids.length ? ids.map((id) => `<@&${id}>`).join(', ') : tr('setup.none'));
  let logsLine = tr('setup.none');
  if (s.logsChannelId) {
    const status = logs === 'unknown' || logs === null
      ? `⚠️ ${tr('setup.perms.unknown')}`
      : logs.missing.length
        ? `⚠️ ${tr('setup.perms.missing', { perms: logs.missing.map((k) => tr(k)).join(', ') })}`
        : `✅ ${tr('setup.perms.ok')}`;
    logsLine = `<#${s.logsChannelId}> · ${tr(`setup.level.${s.logsLevel}`)} · ${status}`;
  }
  const content = [
    tr('setup.title'),
    `${tr('setup.memberRoles')}: ${roles(s.memberRoleIds)}`,
    `${tr('setup.officerRoles')}: ${roles(s.officerRoleIds)}`,
    `${tr('setup.baseLang')}: ${tr(`setup.lang.${s.baseLang}`)}`,
    `${tr('setup.logs')}: ${logsLine}`,
    `-# ${tr('setup.saved')}`,
  ].join('\n');

  const row = (component: MessageActionRowComponentBuilder) =>
    new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(component);
  const roleSelect = (id: string, placeholder: MessageKey, selected: string[]) =>
    new RoleSelectMenuBuilder().setCustomId(`${NAME}:${id}`).setPlaceholder(tr(placeholder))
      .setMinValues(0).setMaxValues(25).setDefaultRoles(...selected);
  const components = [
    row(roleSelect('memberRoles', 'setup.pick.memberRoles', s.memberRoleIds)),
    row(roleSelect('officerRoles', 'setup.pick.officerRoles', s.officerRoleIds)),
    row(new StringSelectMenuBuilder().setCustomId(`${NAME}:baseLang`).setPlaceholder(tr('setup.pick.baseLang'))
      .addOptions(LANGS.map((l) => ({ label: tr(`setup.lang.${l}`), value: l, default: l === s.baseLang })))),
    row(new ChannelSelectMenuBuilder().setCustomId(`${NAME}:logsChannel`).setPlaceholder(tr('setup.pick.logsChannel'))
      .setChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
      .setMinValues(0).setMaxValues(1).setDefaultChannels(...(s.logsChannelId ? [s.logsChannelId] : []))),
    row(new StringSelectMenuBuilder().setCustomId(`${NAME}:logsLevel`).setPlaceholder(tr('setup.pick.logsLevel'))
      // The select shows only the chosen label, so it names what it is about
      .addOptions(LOGS_LEVELS.map((l) => ({ label: `${tr('setup.logs')}: ${tr(`setup.level.${l}`)}`, value: l, default: l === s.logsLevel })))),
  ];
  // Role and channel mentions render but must never ping
  return { content, components, allowedMentions: { parse: [] } };
}

function requireManageGuild(perms: Readonly<PermissionsBitField> | null) {
  if (!perms?.has(PermissionFlagsBits.ManageGuild)) throw new UserError('error.manageGuild');
}

/** The settings change one selection stands for; null for an unknown or invalid value. */
export function patchFor(field: string, values: string[]): Partial<GuildSettings> | null {
  switch (field) {
    case 'memberRoles': return { memberRoleIds: values };
    case 'officerRoles': return { officerRoleIds: values };
    case 'baseLang': return LANGS.includes(values[0] as Lang) ? { baseLang: values[0] as Lang } : null;
    case 'logsChannel': return { logsChannelId: values[0] ?? null };
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
    await ctx.reply(setupPanel(settings, ctx.lang, checkLogsChannel(interaction.guild, settings.logsChannelId)));
  },
  async component(ctx) {
    const { interaction } = ctx;
    if (!interaction.inGuild()) throw new UserError('error.guildOnly');
    requireManageGuild(interaction.memberPermissions);
    const field = interaction.customId.slice(NAME.length + 1);
    const patch = interaction.isAnySelectMenu() ? patchFor(field, interaction.values) : null;
    if (!patch) throw new Error(`Unexpected setup component ${interaction.customId}`);
    // The panel may outlive a database reset: make sure the rows exist before updating them
    await ensureGuild(ctx.db, interaction.guildId, interaction.guild?.name ?? interaction.guildId);
    const settings = await updateGuildSettings(ctx.db, interaction.guildId, patch);
    await interaction.update(setupPanel(settings, ctx.lang, checkLogsChannel(interaction.guild, settings.logsChannelId)));
  },
};
