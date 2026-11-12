// The Star Citizen game folder (the channel folder, e.g. `...\StarCitizen\LIVE`): its check, its version and the
// player's language pack. READ ONLY: nothing in the game folder is ever written, created or locked, and nothing in
// here throws for what it finds there (docs/singleuser.md "The game folder").
import { readFileSync, statSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { parseIniFile } from '../catalog/import/loc-import.ts';
import { gameLabel } from '../catalog/game-label.ts';
import type { GameFolderProblem, GameFolderState, LanguagePackProblem } from '../webapp/api-types.ts';

const isDir = (path: string) => {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
};
const isFile = (path: string) => {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
};

/** Valid when the folder holds `Data.p4k` and `build_manifest.id`; else which of them is missing. */
export function checkGameFolder(dir: string): { ok: true } | { ok: false; problem: GameFolderProblem } {
  if (!isAbsolute(dir) || !isDir(dir)) return { ok: false, problem: 'notFolder' };
  if (!isFile(join(dir, 'Data.p4k'))) return { ok: false, problem: 'noDataP4k' };
  if (!isFile(join(dir, 'build_manifest.id'))) return { ok: false, problem: 'noBuildManifest' };
  return { ok: true };
}

/** The game version (`gameLabel` of `build_manifest.id`); null when the manifest cannot be read or lacks the fields. */
export function readGameVersion(dir: string): string | null {
  try {
    return gameLabel(JSON.parse(readFileSync(join(dir, 'build_manifest.id'), 'utf8')));
  } catch {
    return null;
  }
}

/** The state the API shows: unset, invalid with the reason, or ok with the version when it is readable. */
export function describeGameFolder(dir: string | null): GameFolderState {
  if (dir === null) return { state: 'unset' };
  const check = checkGameFolder(dir);
  if (!check.ok) return { state: 'invalid', problem: check.problem };
  const gameVersion = readGameVersion(dir);
  return gameVersion === null ? { state: 'ok' } : { state: 'ok', gameVersion };
}

/**
 * The `g_language` of a `user.cfg` text, null when it sets none. The companion's rule (sc-ohseearr `locale::language_of`),
 * mirrored exactly: per line everything from the first `;` on is a comment; `key = value` split at the first `=`; the
 * key matches case-insensitively, the value is trimmed (quotes are not treated specially); a line with an empty value
 * is skipped, the first line with a value wins.
 */
export function languageOf(cfg: string): string | null {
  for (const raw of cfg.split(/\r?\n/)) {
    const line = raw.split(';')[0]!.trim();
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const value = line.slice(eq + 1).trim();
    if (line.slice(0, eq).trim().toLowerCase() === 'g_language' && value !== '') return value;
  }
  return null;
}

export interface LanguagePack {
  /** The language whose pack was looked for (`g_language`, else the default `english`); null when `user.cfg` gives none and no pack was found. */
  language: string | null;
  /** The `global.ini` that was read; null when none was. */
  file: string | null;
  /** Loc key (lower case) -> display text; null when no pack was read. */
  texts: Map<string, string> | null;
  /** Why there are no texts (none of them is fatal: the app then shows the game's English). */
  problem?: LanguagePackProblem;
}

/**
 * The player's language pack, by the companion's rule (sc-ohseearr `locale::pack_path`): the language is the
 * `g_language` of `<dir>/user.cfg` (none = `english`), the file `<dir>/data/Localization/<language>/global.ini` (`Data`
 * is tried when `data` is no folder: Linux). The English default usually has no file: the game's English lives inside
 * `Data.p4k`. Parsed with `parseIniFile`; a file without a single usable text is not taken for a `global.ini`.
 * Never throws, never writes.
 */
export function readLanguagePack(dir: string): LanguagePack {
  let cfg: string | null = null;
  try {
    cfg = readFileSync(join(dir, 'user.cfg'), 'utf8');
  } catch { /* none or unreadable: the same as none, as for the companion */ }
  const configured = cfg === null ? null : languageOf(cfg);
  const language = configured ?? 'english';
  const none = (problem: LanguagePackProblem): LanguagePack => ({ language: configured, file: null, texts: null, problem });
  const notFound = (): LanguagePack => {
    if (cfg === null) return none('noUserCfg');
    if (configured === null) return none('noLanguage');
    return language.toLowerCase() === 'english' ? none('builtInEnglish') : none('iniMissing');
  };

  // The language names a folder: never a path (the companion would follow one; nothing legitimate looks like this)
  if (/[\/]|^\.+$/.test(language)) return notFound();
  const data = ['data', 'Data'].map((d) => join(dir, d)).find(isDir) ?? join(dir, 'data');
  const file = join(data, 'Localization', language, 'global.ini');
  if (!isFile(file)) return notFound();

  let texts: Map<string, string>;
  try {
    texts = new Map(Object.entries(parseIniFile(readFileSync(file)).texts));
  } catch {
    return { language, file, texts: null, problem: 'iniUnreadable' };
  }
  if (texts.size === 0) return { language, file, texts: null, problem: 'iniEmpty' };
  return { language, file, texts };
}
