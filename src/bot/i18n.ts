// Bot UI texts (de/en) and language resolution. Game texts come from the catalog, not from here.
// Private output follows the user's client locale, public output the server's base language.

export type Lang = 'en' | 'de';

const en = {
  'error.generic': 'Something went wrong. The error has been logged.',
  'error.unknownCommand': 'This command is not available (anymore).',
  'error.guildOnly': 'This command only works on a server.',
  'error.manageGuild': 'You need the Manage Server permission for this.',
  'error.notSetUp': 'The bot is not set up on this server yet. An admin has to run /qm-setup first.',
  'error.notMember': "You need one of the org's member or officer roles for this.",

  'cmd.setup': 'Set up the bot for this server: roles, language, logs',
  'setup.title': '**Quartermaster setup**',
  'setup.memberRoles': 'Member roles',
  'setup.officerRoles': 'Officer roles',
  'setup.baseLang': 'Base language (public output)',
  'setup.logs': 'Logs',
  'setup.none': 'none',
  'setup.saved': 'Changes are saved immediately.',
  'setup.pick.memberRoles': 'Member roles: book their own stock',
  'setup.pick.officerRoles': 'Officer roles: also book org stock',
  'setup.pick.baseLang': 'Base language',
  'setup.pick.logsChannel': 'Logs channel (none = no logs)',
  'setup.pick.logsLevel': 'What gets logged',
  'setup.lang.en': 'English',
  'setup.lang.de': 'Deutsch',
  'setup.level.off': 'Off',
  'setup.level.org': 'Org stock bookings',
  'setup.perms.ok': 'the bot can post there',
  'setup.perms.missing': 'missing bot permissions: {perms}',
  'setup.perms.unknown': 'channel not found, permissions not checked',
  'perm.viewChannel': 'View Channel',
  'perm.sendMessages': 'Send Messages',
  'perm.embedLinks': 'Embed Links',
  'perm.attachFiles': 'Attach Files',
} as const;

export type MessageKey = keyof typeof en;

// Same keys as English, enforced by the type (and checked at runtime by the tests)
const de: Record<MessageKey, string> = {
  'error.generic': 'Da ist etwas schiefgelaufen. Der Fehler wurde protokolliert.',
  'error.unknownCommand': 'Dieser Befehl ist nicht (mehr) verfügbar.',
  'error.guildOnly': 'Dieser Befehl funktioniert nur auf einem Server.',
  'error.manageGuild': 'Dafür brauchst du die Berechtigung „Server verwalten“.',
  'error.notSetUp': 'Der Bot ist auf diesem Server noch nicht eingerichtet. Ein Admin muss zuerst /qm-setup ausführen.',
  'error.notMember': 'Dafür brauchst du eine der Member- oder Officer-Rollen der Org.',

  'cmd.setup': 'Bot für diesen Server einrichten: Rollen, Sprache, Logs',
  'setup.title': '**Quartermaster-Einrichtung**',
  'setup.memberRoles': 'Member-Rollen',
  'setup.officerRoles': 'Officer-Rollen',
  'setup.baseLang': 'Basissprache (öffentliche Ausgaben)',
  'setup.logs': 'Logs',
  'setup.none': 'keine',
  'setup.saved': 'Änderungen werden sofort gespeichert.',
  'setup.pick.memberRoles': 'Member-Rollen: buchen ihren eigenen Bestand',
  'setup.pick.officerRoles': 'Officer-Rollen: buchen auch Org-Bestand',
  'setup.pick.baseLang': 'Basissprache',
  'setup.pick.logsChannel': 'Logs-Channel (keiner = keine Logs)',
  'setup.pick.logsLevel': 'Was geloggt wird',
  'setup.lang.en': 'English',
  'setup.lang.de': 'Deutsch',
  'setup.level.off': 'Aus',
  'setup.level.org': 'Buchungen von Org-Bestand',
  'setup.perms.ok': 'der Bot kann dort posten',
  'setup.perms.missing': 'dem Bot fehlen Rechte: {perms}',
  'setup.perms.unknown': 'Channel nicht gefunden, Rechte nicht geprüft',
  'perm.viewChannel': 'Kanal ansehen',
  'perm.sendMessages': 'Nachrichten senden',
  'perm.embedLinks': 'Links einbetten',
  'perm.attachFiles': 'Dateien anhängen',
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
 * Language for public output on a server (logs channel, anything several people see).
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
