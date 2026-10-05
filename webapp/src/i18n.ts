// UI texts, German and English (like the bot). The language follows the browser until the user picks
// one; game texts will follow the same choice.
import { ref, watch } from "vue";

export type Lang = "de" | "en";
export const LANGS: Lang[] = ["de", "en"];

const en = {
  "app.tagline": "Stock and blueprints for Star Citizen",
  "error.backend": "Server not reachable.",
  "lang.title": "Language",
  "login.button": "Log in with Discord",
  "login.hint": "Only your Discord user ID, name and avatar are read.",
  "login.failed": "Login failed. Please try again.",
  "login.denied": "Login cancelled.",
  "nav.home": "Overview",
  "user.logout": "Log out",
  "home.welcome": "Logged in as {name}",
  "home.orgs": "Your orgs",
  "home.noOrgs": "You are not in any org. Personal stock and blueprints work without one.",
  "home.officer": "Officer",
  "home.member": "Member",
  "home.readOnly": "Read-only",
  "home.botMissing": "Bot not on the server",
  "home.botMissingHint": "The Discord bot was removed from this server: the member list is no longer kept current, its org stock is read-only.",
  "home.rosterStale": "The Discord bot cannot confirm the member list of this org right now (offline or syncing): its org stock is read-only until it can.",
};
type Key = keyof typeof en;

// Same keys as en, enforced by the type
const de: Record<Key, string> = {
  "app.tagline": "Bestand und Blueprints für Star Citizen",
  "error.backend": "Server nicht erreichbar.",
  "lang.title": "Sprache",
  "login.button": "Mit Discord anmelden",
  "login.hint": "Gelesen werden nur deine Discord-ID, dein Name und dein Avatar.",
  "login.failed": "Anmeldung fehlgeschlagen. Bitte noch einmal versuchen.",
  "login.denied": "Anmeldung abgebrochen.",
  "nav.home": "Übersicht",
  "user.logout": "Abmelden",
  "home.welcome": "Angemeldet als {name}",
  "home.orgs": "Deine Orgs",
  "home.noOrgs": "Du bist in keiner Org. Persönlicher Bestand und Blueprints funktionieren auch ohne.",
  "home.officer": "Officer",
  "home.member": "Member",
  "home.readOnly": "Nur lesbar",
  "home.botMissing": "Bot nicht auf dem Server",
  "home.botMissingHint": "Der Discord-Bot wurde von diesem Server entfernt: Die Mitgliederliste wird nicht mehr abgeglichen, der Org-Bestand ist nur lesbar.",
  "home.rosterStale": "Der Discord-Bot kann die Mitgliederliste dieser Org gerade nicht bestätigen (offline oder Abgleich läuft): Ihr Org-Bestand ist bis dahin nur lesbar.",
};

const TEXTS: Record<Lang, Record<Key, string>> = { de, en };
const KEY = "qm.webapp.lang";

function load(): Lang {
  try {
    const stored = localStorage.getItem(KEY);
    if (stored === "de" || stored === "en") return stored;
  } catch {
    // localStorage unavailable: fall back to the browser language
  }
  return navigator.language.toLowerCase().startsWith("de") ? "de" : "en";
}

export const lang = ref<Lang>(load());

watch(lang, (l) => {
  document.documentElement.lang = l;
  try {
    localStorage.setItem(KEY, l);
  } catch {
    // The choice simply does not persist
  }
}, { immediate: true });

/** Text in the current language; `{name}` placeholders from vars. Reactive in templates. */
export function t(key: Key, vars: Record<string, string | number> = {}): string {
  return TEXTS[lang.value][key].replace(/\{(\w+)\}/g, (m, name: string) => (name in vars ? String(vars[name]) : m));
}
