// Imports or removes an externally maintained global.ini as localization source.
// Exit codes: 0 = imported / dry run / nothing to do, 1 = error, 2 = blocked by a safeguard.
import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { connect } from '../../db/client.ts';
import { textDiffCounts } from './apply.ts';
import { parseIniFile, runLocImport, runLocRemove } from './loc-import.ts';
import { sha256 } from './plan.ts';

const HELP = `Usage: pnpm loc:import <global.ini> --source <name> --lang <code> [options]
       pnpm loc:import --remove --source <name> --lang <code> [--dry-run]

  --source <name>           Name of the text source, e.g. community-de ("game" is reserved)
  --lang <code>             Language code, e.g. de
  --priority <n>            Higher wins over lower; game = 0 (default: current, or 100 for a new source)
  --dry-run                 Run in a transaction and roll it back
  --force                   Override safeguards, re-import identical texts
  --max-remove-ratio <r>    Max share of the source's texts that may disappear (default 0.5)
  --min-game-overlap <r>    Min share of the file's keys known to the game (default 0.5)
  --remove                  Remove the source for this language
  --json                    Print the result as JSON
  -h, --help

Database: $DATABASE_URL`;

async function main(): Promise<number> {
  const { values: args, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      'source': { type: 'string' },
      'lang': { type: 'string' },
      'priority': { type: 'string' },
      'dry-run': { type: 'boolean', default: false },
      'force': { type: 'boolean', default: false },
      'max-remove-ratio': { type: 'string', default: '0.5' },
      'min-game-overlap': { type: 'string', default: '0.5' },
      'remove': { type: 'boolean', default: false },
      'json': { type: 'boolean', default: false },
      'help': { type: 'boolean', short: 'h', default: false },
    },
  });
  const wantFile = !args.remove;
  if (args.help || !args.source || !args.lang || positionals.length !== (wantFile ? 1 : 0)) {
    console.log(HELP);
    return args.help ? 0 : 1;
  }
  const ratio = (name: string, v: string) => {
    const n = Number(v);
    if (!(n >= 0 && n <= 1)) throw new Error(`--${name} must be between 0 and 1`);
    return n;
  };
  let priority: number | null = null;
  if (args.priority !== undefined) {
    priority = Number(args.priority);
    if (!Number.isInteger(priority)) throw new Error('--priority must be an integer');
  }
  const log = args.json ? () => {} : (msg = '') => console.log(msg);
  const { db, close } = connect(process.env.DATABASE_URL);
  try {
    if (args.remove) {
      const removed = await runLocRemove(db, args.source, args.lang, args['dry-run']);
      if (args.json) console.log(JSON.stringify({ removed, dryRun: args['dry-run'] }, null, 2));
      else if (!removed) log(`No source "${args.source}" for "${args.lang}".`);
      else log(`${args['dry-run'] ? 'DRY RUN: would remove' : 'Removed'} source "${removed.source}" for "${removed.lang}" (${removed.keyCount} texts, priority ${removed.priority}).`);
      return 0;
    }

    const file = resolve(positionals[0]!);
    const bytes = readFileSync(file);
    const ini = parseIniFile(bytes);
    const result = await runLocImport(db, ini.texts, {
      source: args.source,
      lang: args.lang,
      priority,
      origin: file,
      dryRun: args['dry-run'],
      force: args.force,
      maxRemoveRatio: ratio('max-remove-ratio', args['max-remove-ratio']),
      minGameOverlap: ratio('min-game-overlap', args['min-game-overlap']),
    });

    if (args.json) {
      console.log(JSON.stringify({
        status: result.status, source: args.source, lang: args.lang, priority: result.priority,
        file: { path: file, bytes: bytes.length, sha256: sha256(bytes), keys: ini.parsed, placeholders: ini.placeholders, appKeys: ini.appKeys },
        texts: textDiffCounts(result.diff), knownToGame: result.knownToGame, gameKeys: result.gameKeys, wins: result.wins,
        violations: result.violations, warnings: result.warnings, sources: result.sources,
      }, null, 2));
    } else {
      const pct = (a: number, b: number) => `${((a / b) * 100).toFixed(1)}%`;
      log(`File: ${file} (${(statSync(file).size / 1024 / 1024).toFixed(1)} MB, sha256 ${sha256(bytes).slice(0, 12)}…)`);
      log(`      ${ini.parsed} keys, ${ini.placeholders} "translation not found" placeholders skipped, ${result.diff.total} texts`);
      if (ini.appKeys) log(`Warning: ${ini.appKeys} keys with the app's reserved prefix skipped (app texts never come from a file)`);
      if (result.knownToGame !== null && result.gameKeys) {
        log(`Game: ${result.knownToGame} of ${result.diff.total} keys known to the game (${pct(result.knownToGame, result.diff.total)}), `
          + `covering ${pct(result.knownToGame, result.gameKeys)} of the game's ${result.gameKeys} English keys`);
      }
      const p = result.previous;
      log(`Source "${args.source}" / ${args.lang}: ${p ? `previous import ${p.importedAt.toISOString()} (${p.keyCount} texts, priority ${p.priority})` : 'new'}, priority now ${result.priority}\n`);
      const counts = textDiffCounts(result.diff);
      const cols = ['total', 'added', 'changed', 'unchanged', 'removed'] as const;
      log(`${''.padEnd(10)}${cols.map((k) => k.padStart(10)).join('')}`);
      log(`${'texts'.padEnd(10)}${cols.map((k) => String(counts[k]).padStart(10)).join('')}\n`);
      if (result.wins !== null) log(`Effective: "${args.source}" provides ${result.wins} of the "${args.lang}" texts`);
      if (result.sources.length > 0) {
        log(`Sources for "${args.lang}":`);
        for (const s of result.sources) log(`  ${String(s.priority).padStart(5)}  ${s.source.padEnd(24)} ${String(s.keyCount).padStart(7)} texts  ${s.origin}`);
      }
      for (const w of result.warnings) log(`Warning: ${w}`);
      for (const v of result.violations) log(`BLOCKED [${v.code}]: ${v.message} -> ${v.override}`);
      log({
        'imported': '\nImported.',
        'dry-run': '\nDRY RUN: rolled back, nothing written.',
        'noop': '\nNothing to do: identical texts with the same priority already imported. Use --force to re-import.',
        'blocked': '\nBlocked by safeguards, nothing written.',
      }[result.status]);
    }
    return result.status === 'blocked' ? 2 : 0;
  } finally {
    await close();
  }
}

main().then((code) => process.exit(code), (err: unknown) => {
  console.error(`\nLocalization import failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
