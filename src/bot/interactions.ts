// Interaction router: dispatches slash commands, autocomplete, components and modal submits to the
// registry, defers slow commands before Discord's 3 s limit and turns errors into replies.
import {
  MessageFlags, type AutocompleteInteraction, type ChatInputCommandInteraction, type Interaction, type MessageComponentInteraction,
  type ModalBuilder, type ModalSubmitInteraction,
} from 'discord.js';
import type { Db } from '../db/client.ts';
import { UserError } from './errors.ts';
import { t, userLang, type Lang } from './i18n.ts';
import { resolveLang } from './lang.ts';
import type { Registry, ReplyContent } from './registry.ts';
import { webAppRow } from './ui.ts';

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
    return this.ephemeral ? MessageFlags.Ephemeral : 0;
  }

  defer(log: Log) {
    if (this.sent || this.deferring) return;
    this.deferring = this.interaction.deferReply({ flags: this.flags || undefined }).then(
      () => {},
      (err: unknown) => log(`deferReply failed for /${this.interaction.commandName}`, err),
    );
  }

  async send(content: ReplyContent) {
    if (this.deferring) await this.deferring;
    const { flags = 0, ...options } = typeof content === 'string' ? { content } : content;
    if (this.sent) {
      await this.interaction.followUp({ ...options, flags: this.flags | flags || undefined });
      return;
    }
    this.sent = true;
    // The deferred reply is already ephemeral or not; an edit only adds IsComponentsV2
    if (this.interaction.deferred) await this.interaction.editReply(flags ? { ...options, flags } : options);
    else await this.interaction.reply({ ...options, flags: this.flags | flags || undefined });
  }

  async showModal(modal: ModalBuilder) {
    // Only possible as the first response: a refusal here is a bug in the command (not in modalSubcommands)
    if (this.sent || this.deferring) throw new Error(`/${this.interaction.commandName}: a modal must be the first response`);
    this.sent = true;
    await this.interaction.showModal(modal);
  }
}

/** The reply to a failed interaction: a UserError's message (with the web app link if it offers it), else the generic one. */
function errorMessage(lang: Lang, err: unknown) {
  if (!(err instanceof UserError)) return { content: t(lang, 'error.generic') };
  const row = err.webApp ? webAppRow(lang) : [];
  return { content: t(lang, err.key, err.vars), ...(row.length ? { components: row } : {}) };
}

/** The user's language; a failed override lookup falls back to the client locale. */
function langOf(db: Db, interaction: Pick<Interaction, 'user' | 'locale'>, log: Log) {
  return resolveLang(db, interaction.user.id, interaction.locale).catch((err: unknown) => {
    log(`Language override lookup failed for user ${interaction.user.id}`, err);
    return userLang(interaction.locale);
  });
}

export async function handleInteraction(interaction: Interaction, registry: Registry, options: RouterOptions = {}) {
  const log = options.log ?? defaultLog;
  const db = options.db as Db;
  if (interaction.isAutocomplete()) return handleAutocomplete(interaction, registry, db, log);
  if (interaction.isMessageComponent() || interaction.isModalSubmit()) return handleComponent(interaction, registry, db, log);
  if (!interaction.isChatInputCommand()) return;

  const command = registry.get(interaction.commandName);
  const responder = new Responder(interaction, command?.ephemeral ?? true);
  // A subcommand that may open a modal is never deferred (a modal after a defer is refused)
  const sub = interaction.options.getSubcommand(false) ?? '';
  const timer = command?.modalSubcommands?.includes(sub) ? undefined : setTimeout(() => responder.defer(log), options.deferAfterMs ?? DEFER_AFTER_MS);
  const lang = await langOf(db, interaction, log);
  try {
    if (!command) throw new UserError('error.unknownCommand');
    await command.execute({
      interaction,
      lang,
      t: (key, vars) => t(lang, key, vars),
      reply: (content) => responder.send(content),
      showModal: (modal) => responder.showModal(modal),
      db,
    });
  } catch (err) {
    const isUser = err instanceof UserError;
    if (!isUser) log(`/${interaction.commandName} failed (guild ${interaction.guildId ?? '-'}, user ${interaction.user.id})`, err);
    try {
      await responder.send(errorMessage(lang, err));
    } catch (sendErr) {
      log(`Could not send the error reply for /${interaction.commandName}`, sendErr);
    }
  } finally {
    clearTimeout(timer);
  }
}

/** Buttons and selects (`component`) and modal submits (`modal`), routed by the custom ID's `<command name>:`. */
async function handleComponent(interaction: MessageComponentInteraction | ModalSubmitInteraction, registry: Registry, db: Db, log: Log) {
  const commandName = interaction.customId.split(':', 1)[0]!;
  const command = registry.get(commandName);
  const lang = await langOf(db, interaction, log);
  const what = interaction.isModalSubmit() ? 'Modal' : 'Component';
  try {
    const tr = (key: Parameters<typeof t>[1], vars?: Parameters<typeof t>[2]) => t(lang, key, vars);
    if (interaction.isModalSubmit()) {
      if (!command?.modal) throw new UserError('error.unknownCommand');
      await command.modal({ interaction, lang, t: tr, db });
    } else {
      if (!command?.component) throw new UserError('error.unknownCommand');
      await command.component({ interaction, lang, t: tr, db });
    }
  } catch (err) {
    const isUser = err instanceof UserError;
    if (!isUser) log(`${what} ${interaction.customId} failed (guild ${interaction.guildId ?? '-'}, user ${interaction.user.id})`, err);
    const message = errorMessage(lang, err);
    try {
      // A deferred reply (deferReply sets `ephemeral`, deferUpdate does not) is still "thinking…": answer in it
      if (interaction.deferred && !interaction.replied && interaction.ephemeral !== null) await interaction.editReply({ components: [], ...message });
      else if (interaction.replied || interaction.deferred) await interaction.followUp({ ...message, flags: MessageFlags.Ephemeral });
      else await interaction.reply({ ...message, flags: MessageFlags.Ephemeral });
    } catch (sendErr) {
      log(`Could not send the error reply for ${interaction.customId}`, sendErr);
    }
  }
}

async function handleAutocomplete(interaction: AutocompleteInteraction, registry: Registry, db: Db, log: Log) {
  const command = registry.get(interaction.commandName);
  try {
    if (command?.autocomplete) await command.autocomplete(interaction, await langOf(db, interaction, log), db);
    else await interaction.respond([]);
  } catch (err) {
    log(`Autocomplete for /${interaction.commandName} failed`, err);
    if (!interaction.responded) await interaction.respond([]).catch(() => {});
  }
}
