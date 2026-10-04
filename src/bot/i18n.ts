// Bot UI texts (de/en) and language resolution. Game texts come from the catalog, not from here.
// Private output follows the user's client locale, public output the server's base language.

export type Lang = 'en' | 'de';

const en = {
  'error.generic': 'Something went wrong. The error has been logged.',
  'error.unknownCommand': 'This command is not available (anymore).',
  'error.guildOnly': 'This command only works on a server.',
} as const;

export type MessageKey = keyof typeof en;

// Same keys as English, enforced by the type (and checked at runtime by the tests)
const de: Record<MessageKey, string> = {
  'error.generic': 'Da ist etwas schiefgelaufen. Der Fehler wurde protokolliert.',
  'error.unknownCommand': 'Dieser Befehl ist nicht (mehr) verfügbar.',
  'error.guildOnly': 'Dieser Befehl funktioniert nur auf einem Server.',
};

export const MESSAGES: Record<Lang, Record<MessageKey, string>> = { en, de };

export type MessageVars = Record<string, string | number>;

/** Text for a key, with `{name}` placeholders filled from vars (unknown placeholders stay as they are). */
export function t(lang: Lang, key: MessageKey, vars: MessageVars = {}): string {
  return MESSAGES[lang][key].replace(/\{(\w+)\}/g, (m, name: string) => (name in vars ? String(vars[name]) : m));
}

/** Language for private output: Discord locale `de` → German, everything else → English. */
export function userLang(locale: string | null | undefined): Lang {
  return locale?.toLowerCase().startsWith('de') ? 'de' : 'en';
}

/**
 * Language for public output on a server (#logs, anything several people see).
 * PLACEHOLDER: always English until the guild settings table exists; then read the configured
 * base language. Never use Discord's guildLocale for this (see .claude/requirements.md).
 */
export async function guildLang(_guildId: string | null): Promise<Lang> {
  return 'en';
}

/** `description` + `description_localizations` for a command or option, from one message key. */
export function localizedDescription(key: MessageKey): { description: string; description_localizations: { de: string } } {
  return { description: t('en', key), description_localizations: { de: t('de', key) } };
}
