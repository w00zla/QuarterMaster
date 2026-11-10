// Imports a catalog snapshot into the database.
// Exit codes: 0 = imported / dry run / nothing to do, 1 = error, 2 = blocked by a safeguard.
import { readFileSync, statSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { sql } from 'drizzle-orm';
import { connect } from '../../db/client.ts';
import { runImport, summarize } from './apply.ts';
import { loadSnapshot } from './load.ts';
import { ENTITY_NAMES } from './plan.ts';

const HELP = `Usage: pnpm catalog:import <snapshot.json[.gz]> [options]

  --dry-run                 Run the full import in a transaction and roll it back
  --force                   Override mass-retire/mass-change safeguards, re-import an identical snapshot
  --allow-downgrade         Allow a snapshot older than the last import
  --max-retire-ratio <r>    Max share of active rows per entity that may be retired (default 0.1)
  --max-change-ratio <r>    Max share of active rows per entity that may change (default 0.5)
  --json                    Print the result as JSON instead of a report
  -h, --help

Database: $DATABASE_URL`;

async function main(): Promise<number> {
  const { values: args, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      'dry-run': { type: 'boolean', default: false },
      'force': { type: 'boolean', default: false },
      'allow-downgrade': { type: 'boolean', default: false },
      'max-retire-ratio': { type: 'string', default: '0.1' },
      'max-change-ratio': { type: 'string', default: '0.5' },
      'json': { type: 'boolean', default: false },
      'help': { type: 'boolean', short: 'h', default: false },
    },
  });
  if (args.help || positionals.length !== 1) {
    console.log(HELP);
    return args.help ? 0 : 1;
  }
  const ratio = (name: string, v: string) => {
    const n = Number(v);
    if (!(n >= 0 && n <= 1)) throw new Error(`--${name} must be between 0 and 1`);
    return n;
  };
  const options = {
    dryRun: args['dry-run'],
    force: args.force,
    allowDowngrade: args['allow-downgrade'],
    maxRetireRatio: ratio('max-retire-ratio', args['max-retire-ratio']),
    maxChangeRatio: ratio('max-change-ratio', args['max-change-ratio']),
  };
  const log = args.json ? () => {} : (msg = '') => console.log(msg);
  const timings: Record<string, number> = {};

  // --- load and check the snapshot (no DB needed) ---
  const file = positionals[0]!;
  const { snapshot, sha256: hash, timings: loadTimings } = loadSnapshot(readFileSync(file));
  Object.assign(timings, loadTimings);

  const g = snapshot.game;
  log(`Snapshot: ${g.channel} build ${g.build}${g.label ? ` "${g.label}"` : ''} (${g.branch}) extracted ${snapshot.extractedAt}`);
  log(`          ${file} (${(statSync(file).size / 1024 / 1024).toFixed(1)} MB, sha256 ${hash.slice(0, 12)}…, ${snapshot.anomalies.length} extractor anomalies)`);

  // --- import ---
  const { db, close } = connect(process.env.DATABASE_URL);
  try {
    const result = await runImport(db, snapshot, hash, options);
    let catalogBytes: number | null = null;
    if (result.status === 'imported') {
      const [row] = await db.execute<{ bytes: string }>(sql`
        SELECT coalesce(sum(pg_total_relation_size(c.oid)), 0)::text AS bytes
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'catalog' AND c.relkind = 'r'`);
      catalogBytes = Number(row?.bytes ?? 0);
    }
    const allTimings = { ...timings, ...result.timings };

    if (args.json) {
      console.log(JSON.stringify({
        status: result.status, importId: result.status === 'imported' ? result.importId : null, snapshotSha256: hash, game: { ...g, manifest: undefined },
        ...summarize({ ...result, timings: allTimings }),
        violations: result.safeguards.violations, catalogBytes,
      }, null, 2));
    } else {
      const last = result.last;
      log(`Last import: ${last ? `#${last.id} ${last.channel} build ${last.gameBuild}` : 'none'}\n`);
      const s = summarize(result);
      const cols = ['total', 'added', 'changed', 'unchanged', 'revived', 'retired'] as const;
      log(`${''.padEnd(22)}${cols.map((k) => k.padStart(10)).join('')}`);
      for (const name of ENTITY_NAMES) {
        const e = s.entities[name]!;
        log(`${name.padEnd(22)}${cols.map((k) => String(e[k]).padStart(10)).join('')}`);
      }
      log(`\n${'game texts'.padEnd(22)}${['total', 'added', 'changed', 'unchanged', 'removed'].map((k) => k.padStart(10)).join('')}`);
      for (const [lang, l] of Object.entries(s.localization)) {
        log(`${`  ${lang}`.padEnd(22)}${[l.total, l.added, l.changed, l.unchanged, l.removed].map((v) => String(v).padStart(10)).join('')}`);
      }
      log('');
      for (const w of result.safeguards.warnings) log(`Warning: ${w}`);
      for (const v of result.safeguards.violations) log(`BLOCKED [${v.code}]: ${v.message} -> ${v.override}`);
      log(`Timings: ${Object.entries(allTimings).map(([k, v]) => `${k} ${(v / 1000).toFixed(1)}s`).join(' | ')}`);
      if (catalogBytes !== null) log(`Catalog size in DB: ${(catalogBytes / 1024 / 1024).toFixed(1)} MB`);
      log({
        'imported': `\nImported as #${result.importId}.`,
        'dry-run': '\nDRY RUN: rolled back, nothing written.',
        'noop': `\nNothing to do: identical snapshot already imported as #${last?.id}. Use --force to re-import.`,
        'blocked': '\nBlocked by safeguards, nothing written.',
      }[result.status]);
    }
    return result.status === 'blocked' ? 2 : 0;
  } finally {
    await close();
  }
}

main().then((code) => process.exit(code), (err: unknown) => {
  console.error(`\nImport failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
