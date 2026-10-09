// Building blocks for panels (Components V2 messages) and modals, shared by the commands.
// Rule of the bot UI: options search (autocomplete), modals ask (inputs with defaults), panels show.
import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, LabelBuilder, MessageFlags, TextInputBuilder, TextInputStyle,
  type ContainerBuilder, type ModalSubmitInteraction,
} from 'discord.js';
import { t, type Lang } from './i18n.ts';

// Discord limit for custom IDs (components and modals)
const MAX_CUSTOM_ID = 100;

/** `<command>:<part>:<part>…`; a too long ID is a bug (it would be refused by Discord). */
export function customId(command: string, ...parts: (string | number)[]): string {
  const id = [command, ...parts].join(':');
  if (id.length > MAX_CUSTOM_ID) throw new Error(`Custom ID too long (${id.length}): ${id}`);
  return id;
}

/** A panel as a reply or update: one container, no pings. `ctx.reply` adds Ephemeral. */
export function panel(container: ContainerBuilder) {
  return { components: [container], flags: MessageFlags.IsComponentsV2 as number, allowedMentions: { parse: [] } };
}

/** Where the user web app is (unset: panels show no link). Read per call: tests may change the env. */
export const webAppOrigin = () => process.env.WEBAPP_ORIGIN?.replace(/\/+$/, '') || null;

/** Link button to the user web app, or null when its origin is not configured. */
export function webAppButton(lang: Lang): ButtonBuilder | null {
  const origin = webAppOrigin();
  return origin ? new ButtonBuilder().setStyle(ButtonStyle.Link).setURL(origin).setLabel(t(lang, 'ui.openWebApp')) : null;
}

/** The web app link as the components of a plain (not V2) message: one row, or none when not configured. */
export function webAppRow(lang: Lang): ActionRowBuilder<ButtonBuilder>[] {
  const web = webAppButton(lang);
  return web ? [new ActionRowBuilder<ButtonBuilder>().addComponents(web)] : [];
}

export interface TextFieldOptions {
  description?: string;
  value?: string;
  placeholder?: string;
  // Default true (Discord's default)
  required?: boolean;
  paragraph?: boolean;
  // Up to 4000
  maxLength?: number;
}

/** A labelled text input for a modal (label max 45, description max 100 characters). */
export function textField(id: string, label: string, o: TextFieldOptions = {}): LabelBuilder {
  const input = new TextInputBuilder().setCustomId(id).setStyle(o.paragraph ? TextInputStyle.Paragraph : TextInputStyle.Short)
    .setRequired(o.required ?? true);
  if (o.value !== undefined && o.value !== '') input.setValue(o.value);
  if (o.placeholder) input.setPlaceholder(o.placeholder.slice(0, 100));
  if (o.maxLength) input.setMaxLength(o.maxLength);
  const field = new LabelBuilder().setLabel(label.slice(0, 45)).setTextInputComponent(input);
  if (o.description) field.setDescription(o.description.slice(0, 100));
  return field;
}

/** A text input's value, trimmed; '' when left empty. */
export const textValue = (interaction: ModalSubmitInteraction, id: string) => interaction.fields.getTextInputValue(id).trim();
