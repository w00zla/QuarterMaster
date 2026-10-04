// Import of externally maintained global.ini files as an additional localization source.
import { sql, TransactionRollbackError } from 'drizzle-orm';
import type { Db } from '../../db/client.ts';
import { displayText, isMissingTranslation, parseGlobalIni } from '../extract/localization.ts';
import { APP_KEY_PREFIX, isAppKey } from '../labels.ts';
import { IMPORT_LOCK } from './apply.ts';
import {
  APP_SOURCE, DEFAULT_EXTERNAL_PRIORITY, GAME_SOURCE, countWins, readKeys, readSources, readTexts, removeSource, writeTexts, type SourceRow,
} from './localization.ts';
import { diffTexts, textsSha256, type TextDiff, type Violation } from './plan.ts';

const SOURCE_PATTERN = /^[a-z0-9][a-z0-9_.-]{0,63}$/;
const LANG_PATTERN = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;

export interface ParsedIni {
  texts: Record<string, string>;
  // Keys found in the file, incl. placeholders and app keys
  parsed: number;
  placeholders: number;
  // Keys with the app's reserved prefix: never taken from a file
  appKeys: number;
}

/** Decodes a global.ini (UTF-8, or UTF-16 with BOM) into display texts. */
export function parseIniFile(bytes: Uint8Array): ParsedIni {
  const buf = Buffer.from(bytes);
  const text = buf[0] === 0xff && buf[1] === 0xfe ? buf.toString('utf16le')
    : buf[0] === 0xfe && buf[1] === 0xff ? Buffer.from(buf).swap16().toString('utf16le')
      : buf.toString('utf8');
  const texts: Record<string, string> = {};
  let placeholders = 0;
  let appKeys = 0;
  const entries = parseGlobalIni(text);
  for (const [key, value] of entries) {
    if (isAppKey(key)) appKeys++;
    else if (isMissingTranslation(value)) placeholders++;
    else texts[key] = displayText(value);
  }
  return { texts, parsed: entries.size, placeholders, appKeys };
}

export interface LocImportOptions {
  source: string;
  lang: string;
  // null: keep the current priority, or the default for a new source
  priority: number | null;
  origin: string;
  dryRun: boolean;
  force: boolean;
  // Max share of the source's current keys that may disappear
  maxRemoveRatio: number;
  // Min share of the file's keys that must exist in the game's English texts
  minGameOverlap: number;
}

export interface LocImportResult {
  status: 'imported' | 'dry-run' | 'noop' | 'blocked';
  previous: SourceRow | null;
  priority: number;
  diff: TextDiff;
  // Keys of the file known to the game (English), and the game's key count; null without game texts
  knownToGame: number | null;
  gameKeys: number | null;
  // Keys for which this source provides the effective text after the import
  wins: number | null;
  sources: SourceRow[];
  violations: Violation[];
  warnings: string[];
}

export function validateSourceAndLang(source: string, lang: string): string[] {
  const errors: string[] = [];
  if (source === GAME_SOURCE) errors.push(`source "${GAME_SOURCE}" is reserved for the catalog import`);
  else if (source === APP_SOURCE) errors.push(`source "${APP_SOURCE}" is reserved for the app's own texts`);
  else if (!SOURCE_PATTERN.test(source)) errors.push(`invalid source name "${source}" (lower case letters, digits, . _ -)`);
  if (!LANG_PATTERN.test(lang)) errors.push(`invalid language code "${lang}" (e.g. de, pt-BR)`);
  return errors;
}

/** Imports one text set; everything happens in one transaction, a dry run rolls back. */
export async function runLocImport(db: Db, texts: Record<string, string>, opts: LocImportOptions): Promise<LocImportResult> {
  const errors = validateSourceAndLang(opts.source, opts.lang);
  if (errors.length > 0) throw new Error(errors.join('; '));
  if (Object.keys(texts).length === 0) throw new Error('file contains no texts');
  if (Object.keys(texts).some(isAppKey)) throw new Error(`keys starting with "${APP_KEY_PREFIX}" are reserved for the app's own texts`);

  const sha = textsSha256(texts);
  let result: LocImportResult | undefined;
  try {
    await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${IMPORT_LOCK})`);
      const [previous] = await readSources(tx, { source: opts.source, lang: opts.lang });
      const priority = opts.priority ?? previous?.priority ?? DEFAULT_EXTERNAL_PRIORITY;
      const diff = diffTexts(texts, await readTexts(tx, opts.source, opts.lang));
      const gameEn = await readKeys(tx, GAME_SOURCE, 'en');
      const gameLangs = new Set((await readSources(tx, { source: GAME_SOURCE })).map((s) => s.lang));
      const knownToGame = gameEn.size > 0 ? Object.keys(texts).filter((k) => gameEn.has(k)).length : null;

      const violations: Violation[] = [];
      const warnings: string[] = [];
      const violate = (v: Violation) => (opts.force ? warnings.push(`${v.message} (overridden by --force)`) : violations.push(v));
      let noop = false;
      if (previous && previous.contentSha256 === sha && previous.priority === priority) {
        if (opts.force) warnings.push('identical texts already imported (re-import forced)');
        else noop = true;
      }
      if (previous && diff.removed.length >= 3 && diff.removed.length / previous.keyCount > opts.maxRemoveRatio) {
        violate({
          code: 'mass_remove',
          message: `${diff.removed.length} of ${previous.keyCount} texts of this source would disappear (> ${(opts.maxRemoveRatio * 100).toFixed(0)}%)`,
          override: '--force',
        });
      }
      if (knownToGame === null) {
        warnings.push('no game texts imported yet, cannot check the file against the game');
      } else if (knownToGame / diff.total < opts.minGameOverlap) {
        violate({
          code: 'low_overlap',
          message: `only ${knownToGame} of ${diff.total} keys exist in the game (< ${(opts.minGameOverlap * 100).toFixed(0)}%); wrong file?`,
          override: '--force',
        });
      }
      if (gameLangs.size > 0 && !gameLangs.has(opts.lang)) warnings.push(`the game ships no "${opts.lang}" texts; this source has nothing to fall back on but English`);

      result = {
        status: 'imported', previous: previous ?? null, priority, diff, knownToGame, gameKeys: gameEn.size || null,
        wins: null, sources: [], violations, warnings,
      };
      if (noop || violations.length > 0) {
        result.status = noop ? 'noop' : 'blocked';
        result.sources = await readSources(tx, { lang: opts.lang });
        tx.rollback();
      }

      await writeTexts(tx, { source: opts.source, lang: opts.lang, priority, origin: opts.origin, contentSha256: sha, diff });
      result.wins = await countWins(tx, opts.source, opts.lang);
      result.sources = await readSources(tx, { lang: opts.lang });
      if (opts.dryRun) {
        result.status = 'dry-run';
        tx.rollback();
      }
    });
  } catch (err) {
    if (!(err instanceof TransactionRollbackError)) throw err;
  }
  return result!;
}

/** Removes a source for one language. Returns the removed source, or null if it did not exist. */
export async function runLocRemove(db: Db, source: string, lang: string, dryRun: boolean): Promise<SourceRow | null> {
  const errors = validateSourceAndLang(source, lang);
  if (errors.length > 0) throw new Error(errors.join('; '));
  let removed: SourceRow | null = null;
  try {
    await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${IMPORT_LOCK})`);
      [removed = null] = await readSources(tx, { source, lang });
      if (removed) await removeSource(tx, source, lang);
      if (dryRun) tx.rollback();
    });
  } catch (err) {
    if (!(err instanceof TransactionRollbackError)) throw err;
  }
  return removed;
}
