// /qm-profile: RSI handle and the bot's language for you, in a modal. No org needed.
import {
  ApplicationIntegrationType, InteractionContextType, LabelBuilder, MessageFlags, ModalBuilder, RadioGroupBuilder,
  RadioGroupOptionBuilder,
} from 'discord.js';
import { UserError } from '../errors.ts';
import { localizedDescription, t, userLang, type Lang } from '../i18n.ts';
import { loadProfile, parseRsiHandle, saveProfile, type Profile } from '../profile.ts';
import type { BotCommand } from '../registry.ts';
import { escapeMarkdown } from '../markdown.ts';
import { customId, textField, textValue, webAppRow } from '../ui.ts';

const NAME = 'qm-profile';
const FIELD_RSI = 'rsi';
const FIELD_LANG = 'lang';
// Radio value for "follow the Discord client language"
const AUTO = 'auto';

export function profileModal(p: Profile, lang: Lang): ModalBuilder {
  const options = [
    [AUTO, t(lang, 'profile.lang.auto')],
    ['en', t(lang, 'setup.lang.en')],
    ['de', t(lang, 'setup.lang.de')],
  ].map(([value, label]) => new RadioGroupOptionBuilder().setValue(value!).setLabel(label!).setDefault(value === (p.lang ?? AUTO)));
  return new ModalBuilder().setCustomId(customId(NAME, 'save')).setTitle(t(lang, 'profile.title')).addLabelComponents(
    textField(FIELD_RSI, t(lang, 'profile.rsi'), {
      description: t(lang, 'profile.rsi.hint'), value: p.rsiHandle ?? '', required: false, maxLength: 60,
    }),
    new LabelBuilder().setLabel(t(lang, 'profile.lang')).setRadioGroupComponent(
      new RadioGroupBuilder().setCustomId(FIELD_LANG).setRequired(true).addOptions(options)),
  );
}

export const profileCommand: BotCommand = {
  data: {
    name: NAME,
    ...localizedDescription('cmd.profile'),
    contexts: [InteractionContextType.Guild],
    integration_types: [ApplicationIntegrationType.GuildInstall],
  },
  modalSubcommands: [''],
  async execute(ctx) {
    await ctx.showModal(profileModal(await loadProfile(ctx.db, ctx.interaction.user.id), ctx.lang));
  },
  async modal(ctx) {
    const rsiHandle = parseRsiHandle(textValue(ctx.interaction, FIELD_RSI));
    if (rsiHandle === undefined) throw new UserError('profile.err.invalidHandle');
    const picked = ctx.interaction.fields.getRadioGroup(FIELD_LANG, true);
    const lang: Lang | null = picked === 'en' || picked === 'de' ? picked : null;
    await saveProfile(ctx.db, ctx.interaction.user.id, { rsiHandle, lang });
    // The answer already speaks the language just saved
    const now = lang ?? userLang(ctx.interaction.locale);
    const langName = lang ? t(now, lang === 'en' ? 'setup.lang.en' : 'setup.lang.de') : t(now, 'profile.lang.auto');
    await ctx.interaction.reply({
      content: t(now, 'profile.saved', { handle: rsiHandle ? escapeMarkdown(rsiHandle) : t(now, 'profile.none'), lang: langName }),
      components: webAppRow(now),
      flags: MessageFlags.Ephemeral,
      allowedMentions: { parse: [] },
    });
  },
};
