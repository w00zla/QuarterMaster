// Command definitions: the JSON Discord registers plus the handlers the router calls.
import type {
  AutocompleteInteraction,
  ChatInputCommandInteraction,
  InteractionReplyOptions,
  MessageComponentInteraction,
  ModalBuilder,
  ModalSubmitInteraction,
  RESTPostAPIChatInputApplicationCommandsJSONBody,
} from 'discord.js';
import type { Db } from '../db/client.ts';
import { UserError } from './errors.ts';
import type { Lang, MessageKey, MessageVars } from './i18n.ts';

// `flags`: only MessageFlags.IsComponentsV2 (panels); the router adds Ephemeral itself
export type ReplyContent = string | (Pick<InteractionReplyOptions, 'content' | 'embeds' | 'components' | 'allowedMentions'> & { flags?: number });

export interface CommandContext {
  interaction: ChatInputCommandInteraction;
  // Language for this user's (private) output
  lang: Lang;
  t: (key: MessageKey, vars?: MessageVars) => string;
  /** Replies, or edits the deferred reply, or follows up after a first reply. Use this, not interaction.reply. */
  reply: (content: ReplyContent) => Promise<void>;
  /**
   * Opens a modal as the first response (Discord allows it only then, never after a defer). Only for
   * subcommands listed in `modalSubcommands`: the router does not defer those.
   */
  showModal: (modal: ModalBuilder) => Promise<void>;
  db: Db;
}

export type CommandHandler = (ctx: CommandContext) => Promise<void>;

/** A click or selection on a component whose custom ID starts with `<command name>:`. */
export interface ComponentContext {
  // Answer with interaction.update (edit the panel) or interaction.reply
  interaction: MessageComponentInteraction;
  lang: Lang;
  t: (key: MessageKey, vars?: MessageVars) => string;
  db: Db;
}

/** A submitted modal whose custom ID starts with `<command name>:`. */
export interface ModalContext {
  // Answer with interaction.reply, or interaction.update when the modal was opened from a button on a panel
  interaction: ModalSubmitInteraction;
  lang: Lang;
  t: (key: MessageKey, vars?: MessageVars) => string;
  db: Db;
}

export interface BotCommand {
  // Name and options are English; descriptions get `description_localizations` (see localizedDescription)
  data: RESTPostAPIChatInputApplicationCommandsJSONBody;
  execute: CommandHandler;
  // Must answer within 3 s and cannot be deferred; at most 25 choices
  autocomplete?: (interaction: AutocompleteInteraction, lang: Lang, db: Db) => Promise<void>;
  // Components the command's replies carry; custom IDs are `<command name>:<rest>`
  component?: (ctx: ComponentContext) => Promise<void>;
  // Modals the command opens; custom IDs are `<command name>:<rest>`
  modal?: (ctx: ModalContext) => Promise<void>;
  // Subcommands that may answer with a modal ('' = the command without subcommands): never deferred, so they must
  // answer within 3 s (only cached lookups and single-row reads before the modal)
  modalSubcommands?: readonly string[];
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
