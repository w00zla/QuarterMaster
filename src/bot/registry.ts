// Command definitions: the JSON Discord registers plus the handlers the router calls.
import type {
  AutocompleteInteraction,
  ChatInputCommandInteraction,
  InteractionReplyOptions,
  RESTPostAPIChatInputApplicationCommandsJSONBody,
} from 'discord.js';
import { UserError } from './errors.ts';
import type { Lang, MessageKey, MessageVars } from './i18n.ts';

export type ReplyContent = string | Pick<InteractionReplyOptions, 'content' | 'embeds' | 'components' | 'allowedMentions'>;

export interface CommandContext {
  interaction: ChatInputCommandInteraction;
  // Language for this user's (private) output
  lang: Lang;
  t: (key: MessageKey, vars?: MessageVars) => string;
  /** Replies, or edits the deferred reply, or follows up after a first reply. Use this, not interaction.reply. */
  reply: (content: ReplyContent) => Promise<void>;
}

export type CommandHandler = (ctx: CommandContext) => Promise<void>;

export interface BotCommand {
  // Name and options are English; descriptions get `description_localizations` (see localizedDescription)
  data: RESTPostAPIChatInputApplicationCommandsJSONBody;
  execute: CommandHandler;
  // Must answer within 3 s and cannot be deferred; at most 25 choices
  autocomplete?: (interaction: AutocompleteInteraction, lang: Lang) => Promise<void>;
  // Replies are private unless set to false
  ephemeral?: boolean;
}

export type Registry = ReadonlyMap<string, BotCommand>;

export function createRegistry(commands: BotCommand[]): Registry {
  const map = new Map<string, BotCommand>();
  for (const c of commands) {
    if (map.has(c.data.name)) throw new Error(`Duplicate command name: ${c.data.name}`);
    map.set(c.data.name, c);
  }
  return map;
}

/** An execute function that dispatches on the subcommand (`group/sub` for subcommand groups). */
export function bySubcommand(handlers: Record<string, CommandHandler>): CommandHandler {
  return async (ctx) => {
    const group = ctx.interaction.options.getSubcommandGroup(false);
    const sub = ctx.interaction.options.getSubcommand(false);
    const handler = handlers[group ? `${group}/${sub}` : (sub ?? '')];
    if (!handler) throw new UserError('error.unknownCommand');
    await handler(ctx);
  };
}
