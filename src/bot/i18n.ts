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

  'cmd.bp': 'Blueprint registry: who can craft what',
  'cmd.bp.add': 'Register a blueprint you own',
  'cmd.bp.remove': 'Remove a blueprint from your registry',
  'cmd.bp.list': 'List registered blueprints',
  'cmd.bp.who': 'Who in the org has a blueprint',
  'opt.blueprint': 'Blueprint (type to search)',
  'opt.member': 'Org member (default: you)',
  'bp.unknown': 'Unknown blueprint. Pick one from the suggestions.',
  'bp.default': '{name} is a default blueprint: everyone has it, no need to register it.',
  'bp.retired': '{name} is no longer in the game.',
  'bp.added': '✅ Registered: {name}',
  'bp.alreadyAdded': '{name} is already registered.',
  'bp.removed': '🗑️ Removed: {name}',
  'bp.notRegistered': '{name} is not in your registry.',
  'bp.list.title': '**Blueprints of {name}** ({count})',
  'bp.list.empty': '{name} has not registered any blueprints yet.',
  'bp.list.page': 'Page {page} of {pages}',
  'bp.list.other': 'Other',
  'bp.list.retired': 'no longer in the game',
  'bp.list.notMember': '{name} is not an active member of this org.',
  'bp.who.default': '**{name}** is a default blueprint: everyone has it.',
  'bp.who.none': 'Nobody in the org has registered **{name}** yet.',
  'bp.who.some': '**{name}**: {count} member(s)',
  'bp.who.more': '… and {count} more',

  'unit.scu': 'SCU',
  'unit.pcs': 'pcs',
  'stock.org': 'Org',
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

  'cmd.bp': 'Blueprint-Registry: wer kann was craften',
  'cmd.bp.add': 'Einen Blueprint registrieren, den du besitzt',
  'cmd.bp.remove': 'Einen Blueprint aus deiner Registry entfernen',
  'cmd.bp.list': 'Registrierte Blueprints auflisten',
  'cmd.bp.who': 'Wer in der Org hat einen Blueprint',
  'opt.blueprint': 'Blueprint (tippen zum Suchen)',
  'opt.member': 'Org-Mitglied (Standard: du)',
  'bp.unknown': 'Unbekannter Blueprint. Wähl einen aus den Vorschlägen.',
  'bp.default': '{name} ist ein Default-Blueprint: Den hat jeder, registrieren ist nicht nötig.',
  'bp.retired': '{name} gibt es im Spiel nicht mehr.',
  'bp.added': '✅ Registriert: {name}',
  'bp.alreadyAdded': '{name} ist schon registriert.',
  'bp.removed': '🗑️ Entfernt: {name}',
  'bp.notRegistered': '{name} ist nicht in deiner Registry.',
  'bp.list.title': '**Blueprints von {name}** ({count})',
  'bp.list.empty': '{name} hat noch keine Blueprints registriert.',
  'bp.list.page': 'Seite {page} von {pages}',
  'bp.list.other': 'Sonstige',
  'bp.list.retired': 'gibt es im Spiel nicht mehr',
  'bp.list.notMember': '{name} ist kein aktives Mitglied dieser Org.',
  'bp.who.default': '**{name}** ist ein Default-Blueprint: Den hat jeder.',
  'bp.who.none': 'In der Org hat noch niemand **{name}** registriert.',
  'bp.who.some': '**{name}**: {count} Mitglied(er)',
  'bp.who.more': '… und {count} weitere',

  'unit.scu': 'SCU',
  'unit.pcs': 'Stk.',
  'stock.org': 'Org',
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
