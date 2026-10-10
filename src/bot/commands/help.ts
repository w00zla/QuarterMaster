// /qm-help: every other command the user can run, with its subcommands, in the user's language. The texts
// are the commands' own descriptions, so the help never drifts from the registered commands.
import {
  ActionRowBuilder, ApplicationCommandOptionType, ApplicationIntegrationType, ButtonBuilder, ContainerBuilder, InteractionContextType,
  SeparatorBuilder, TextDisplayBuilder, type PermissionsBitField, type RESTPostAPIChatInputApplicationCommandsJSONBody,
} from 'discord.js';
import { localizedDescription, t, type Lang } from '../i18n.ts';
import type { BotCommand } from '../registry.ts';
import { panel, webAppButton } from '../ui.ts';

const NAME = 'qm-help';

type Described = { description: string; description_localizations?: Partial<Record<string, string | null>> | null };

const describe = (lang: Lang, o: Described) => (lang === 'en' ? o.description : o.description_localizations?.[lang] ?? o.description);

/** One block per command: its name in bold with the description, then its subcommands. */
export function helpLines(lang: Lang, list: RESTPostAPIChatInputApplicationCommandsJSONBody[]): string[] {
  return list.map((c) => {
    const subs = (c.options ?? []).filter((o) => o.type === ApplicationCommandOptionType.Subcommand);
    return [`**/${c.name}** · ${describe(lang, c)}`, ...subs.map((s) => `- \`${s.name}\` ${describe(lang, s)}`)].join('\n');
  });
}

/** Every command but this one; those with `default_member_permissions` (admin commands) only for users holding those permissions. */
export function visibleCommands(list: BotCommand[], perms: Readonly<PermissionsBitField> | null) {
  return list.map((c) => c.data).filter((d) => d.name !== NAME
    && (!d.default_member_permissions || !!perms?.has(BigInt(d.default_member_permissions))));
}

export function helpPanel(lang: Lang, list: RESTPostAPIChatInputApplicationCommandsJSONBody[]) {
  const container = new ContainerBuilder()
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(t(lang, 'help.title')))
    .addSeparatorComponents(new SeparatorBuilder())
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(helpLines(lang, list).join('\n\n')));
  const web = webAppButton(lang);
  if (web) container.addActionRowComponents(new ActionRowBuilder<ButtonBuilder>().addComponents(web));
  return panel(container);
}

export const helpCommand: BotCommand = {
  data: {
    name: NAME,
    ...localizedDescription('cmd.help'),
    contexts: [InteractionContextType.Guild],
    integration_types: [ApplicationIntegrationType.GuildInstall],
  },
  async execute(ctx) {
    // Loaded here: the command list imports this file
    const { commands } = await import('../commands.ts');
    await ctx.reply(helpPanel(ctx.lang, visibleCommands(commands, ctx.interaction.memberPermissions)));
  },
};
