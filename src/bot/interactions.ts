// Interaction router: dispatches slash commands, autocomplete and components to the registry,
// defers slow commands before Discord's 3 s limit and turns errors into replies.
import {
  MessageFlags, type AutocompleteInteraction, type ChatInputCommandInteraction, type Interaction, type MessageComponentInteraction,
} from 'discord.js';
import type { Db } from '../db/client.ts';
import { UserError } from './errors.ts';
import { t, userLang } from './i18n.ts';
import type { Registry, ReplyContent } from './registry.ts';

// Discord drops an interaction that is not acknowledged within 3 s
const DEFER_AFTER_MS = 2000;

type Log = (msg: string, err: unknown) => void;

export interface RouterOptions {
  // Optional only for tests whose handlers never touch the database
  db?: Db;
  deferAfterMs?: number;
  log?: Log;
}

const defaultLog: Log = (msg, err) => console.error(msg, err);

/** Sends the first reply, the deferred reply's edit or follow-ups, whichever is due. */
class Responder {
  readonly interaction: ChatInputCommandInteraction;
  readonly ephemeral: boolean;
  sent = false;
  deferring: Promise<void> | null = null;

  constructor(interaction: ChatInputCommandInteraction, ephemeral: boolean) {
    this.interaction = interaction;
    this.ephemeral = ephemeral;
  }

  get flags() {
    return this.ephemeral ? MessageFlags.Ephemeral : undefined;
  }

  defer(log: Log) {
    if (this.sent || this.deferring) return;
    this.deferring = this.interaction.deferReply({ flags: this.flags }).then(
      () => {},
      (err: unknown) => log(`deferReply failed for /${this.interaction.commandName}`, err),
    );
  }

  async send(content: ReplyContent) {
    if (this.deferring) await this.deferring;
    const options = typeof content === 'string' ? { content } : content;
    if (this.sent) {
      await this.interaction.followUp({ ...options, flags: this.flags });
      return;
    }
    this.sent = true;
    if (this.interaction.deferred) await this.interaction.editReply(options);
    else await this.interaction.reply({ ...options, flags: this.flags });
  }
}

export async function handleInteraction(interaction: Interaction, registry: Registry, options: RouterOptions = {}) {
  const log = options.log ?? defaultLog;
  const db = options.db as Db;
  if (interaction.isAutocomplete()) return handleAutocomplete(interaction, registry, log);
  if (interaction.isMessageComponent()) return handleComponent(interaction, registry, db, log);
  if (!interaction.isChatInputCommand()) return;

  const command = registry.get(interaction.commandName);
  const lang = userLang(interaction.locale);
  const responder = new Responder(interaction, command?.ephemeral ?? true);
  const timer = setTimeout(() => responder.defer(log), options.deferAfterMs ?? DEFER_AFTER_MS);
  try {
    if (!command) throw new UserError('error.unknownCommand');
    await command.execute({
      interaction,
      lang,
      t: (key, vars) => t(lang, key, vars),
      reply: (content) => responder.send(content),
      db,
    });
  } catch (err) {
    const isUser = err instanceof UserError;
    if (!isUser) log(`/${interaction.commandName} failed (guild ${interaction.guildId ?? '-'}, user ${interaction.user.id})`, err);
    const text = isUser ? t(lang, err.key, err.vars) : t(lang, 'error.generic');
    try {
      await responder.send(text);
    } catch (sendErr) {
      log(`Could not send the error reply for /${interaction.commandName}`, sendErr);
    }
  } finally {
    clearTimeout(timer);
  }
}

async function handleComponent(interaction: MessageComponentInteraction, registry: Registry, db: Db, log: Log) {
  const commandName = interaction.customId.split(':', 1)[0]!;
  const command = registry.get(commandName);
  const lang = userLang(interaction.locale);
  try {
    if (!command?.component) throw new UserError('error.unknownCommand');
    await command.component({ interaction, lang, t: (key, vars) => t(lang, key, vars), db });
  } catch (err) {
    const isUser = err instanceof UserError;
    if (!isUser) log(`Component ${interaction.customId} failed (guild ${interaction.guildId ?? '-'}, user ${interaction.user.id})`, err);
    const content = isUser ? t(lang, err.key, err.vars) : t(lang, 'error.generic');
    try {
      if (interaction.replied || interaction.deferred) await interaction.followUp({ content, flags: MessageFlags.Ephemeral });
      else await interaction.reply({ content, flags: MessageFlags.Ephemeral });
    } catch (sendErr) {
      log(`Could not send the error reply for ${interaction.customId}`, sendErr);
    }
  }
}

async function handleAutocomplete(interaction: AutocompleteInteraction, registry: Registry, log: Log) {
  const command = registry.get(interaction.commandName);
  try {
    if (command?.autocomplete) await command.autocomplete(interaction, userLang(interaction.locale));
    else await interaction.respond([]);
  } catch (err) {
    log(`Autocomplete for /${interaction.commandName} failed`, err);
    if (!interaction.responded) await interaction.respond([]).catch(() => {});
  }
}
