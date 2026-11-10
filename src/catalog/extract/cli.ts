// Extracts the game catalog from a local Data.p4k into a snapshot file.
// Usage: pnpm catalog:extract [--p4k <Data.p4k>] [--out <file>] [--starbreaker <bin>] [--work <dir>]
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { gzipSync } from 'node:zlib';
import { LANGUAGE_CODES, parseGlobalIni } from './localization.ts';
import { MINING_PATHS } from './mining.ts';
import { normalize } from './normalize.ts';
import { RecordStore } from './records.ts';
import { scanContainerFiles } from './socpak.ts';
import { exportedCount, starbreaker, starbreakerVersion } from './starbreaker.ts';
import { gameLabel } from '../game-label.ts';
import { snapshotSchema } from '../snapshot.ts';

const pkg = JSON.parse(readFileSync(new URL('../../../package.json', import.meta.url), 'utf8')) as { version: string };

// DataCore subtrees to export; referenced entities are picked from these
const DCB_FILTERS = [
  'libs/foundry/records/crafting/**',
  'libs/foundry/records/resourcetypedatabase/**',
  'libs/foundry/records/scitemmanufacturer/**',
  'libs/foundry/records/entities/scitem/**',
  // Armor's damage resistance (the base of its crafted damage mitigation)
  'libs/foundry/records/damage/**',
  // Whole-directory globs only: segment wildcards like '**/*refin*' match nothing in StarBreaker
  'libs/foundry/records/starmap/**',
  // Blueprint sources: contracts (generators, templates, event progress) and what they reference
  'libs/foundry/records/contracts/**',
  'libs/foundry/records/missionscenarios/**',
  'libs/foundry/records/missiontype/**',
  'libs/foundry/records/missiondata/pu_missionlocality/**',
  'libs/foundry/records/factions/**',
  'libs/foundry/records/reputation/**',
  // Mining: provider presets (spawn tables), rock compositions and elements, the rock entities
  'libs/foundry/records/harvestable/**',
  'libs/foundry/records/mining/**',
  'libs/foundry/records/entities/mineable/**',
];

// Object containers of the star systems: where the harvestable providers are used (socpak.ts)
const CONTAINER_FILTER = 'Data/ObjectContainers/PU/system/**/*.socpak';
const CONTAINER_DIR = 'Data/ObjectContainers/PU/system';

const HELP = `Usage: pnpm catalog:extract [options]

  --p4k <path>          Data.p4k of the game install (default: $SC_DATA_P4K)
  --out <file>          Snapshot file (default: local/snapshots/catalog-<channel>-<build>.json.gz)
  --starbreaker <bin>   StarBreaker CLI, our fork (default: $STARBREAKER_BIN, else local/starbreaker-ps/starbreaker, on Windows starbreaker.exe)
  --work <dir>          Working directory for extracted files (default: local/work/<channel>-<build>)
  --keep-work           Keep the working directory afterwards
  --reuse-work          Skip the extraction when the working directory holds it already (normalizer changes)
  -h, --help`;

async function main() {
  const { values: args } = parseArgs({
    options: {
      'p4k': { type: 'string' },
      'out': { type: 'string' },
      // Our fork's CLI per platform: starbreaker (Linux) next to starbreaker.exe (Windows), both built from starbreaker-ps
      'starbreaker': { type: 'string', default: process.env.STARBREAKER_BIN || (process.platform === 'win32' ? 'local/starbreaker-ps/starbreaker.exe' : 'local/starbreaker-ps/starbreaker') },
      'work': { type: 'string' },
      'keep-work': { type: 'boolean', default: false },
      'reuse-work': { type: 'boolean', default: false },
      'help': { type: 'boolean', short: 'h', default: false },
    },
  });
  if (args.help) return console.log(HELP);

  const p4k = resolve(args.p4k ?? process.env.SC_DATA_P4K ?? '');
  if (!args.p4k && !process.env.SC_DATA_P4K) throw new Error('No Data.p4k given (--p4k or $SC_DATA_P4K)');
  if (!existsSync(p4k)) throw new Error(`Data.p4k not found: ${p4k}`);
  const bin = resolve(args.starbreaker);
  if (!existsSync(bin)) throw new Error(`StarBreaker not found: ${bin}`);

  const timings: [string, number][] = [];
  const step = async <T>(label: string, fn: () => Promise<T> | T): Promise<T> => {
    const t0 = performance.now();
    process.stdout.write(`${label} ... `);
    const result = await fn();
    const ms = performance.now() - t0;
    timings.push([label, ms]);
    console.log(`${(ms / 1000).toFixed(1)}s`);
    return result;
  };

  // Game build from the manifest next to Data.p4k; channel from the install folder (LIVE, PTU, ...)
  const manifestFile = join(dirname(p4k), 'build_manifest.id');
  if (!existsSync(manifestFile)) throw new Error(`build_manifest.id not found next to ${p4k}`);
  const manifest = JSON.parse(readFileSync(manifestFile, 'utf8')) as { Data?: Record<string, string> };
  const data = manifest.Data ?? {};
  const build = Number(data.RequestedP4ChangeNum);
  if (!Number.isInteger(build) || build <= 0) throw new Error(`No valid RequestedP4ChangeNum in ${manifestFile}`);
  const channel = basename(dirname(p4k)).toUpperCase();
  const game = {
    channel,
    build,
    branch: data.Branch ?? '',
    version: data.Version ?? '',
    label: gameLabel(manifest),
    manifest,
  };
  const sbVersion = await starbreakerVersion(bin);
  console.log(`Game: ${channel} build ${build} (${game.branch}, ${game.version}) | StarBreaker ${sbVersion}`);

  const work = resolve(args.work ?? join('local/work', `${channel.toLowerCase()}-${build}`));
  const recordsDir = join(work, 'records');
  const reuse = args['reuse-work'] && existsSync(recordsDir);
  if (!reuse) {
    rmSync(work, { recursive: true, force: true });
    mkdirSync(work, { recursive: true });
  }

  const exported: Record<string, number | null> = {};
  if (reuse) {
    console.log(`Reusing ${work}`);
  } else {
    await step('Extract Game2.dcb + global.ini', async () => {
      await starbreaker(bin, ['p4k', 'extract', '--p4k', p4k, '-o', work, '--filter', '**/Game2.dcb']);
      await starbreaker(bin, ['p4k', 'extract', '--p4k', p4k, '-o', work, '--filter', '**/global.ini']);
      await starbreaker(bin, ['p4k', 'extract', '--p4k', p4k, '-o', work, '--filter', CONTAINER_FILTER]);
    });
    const dcb = join(work, 'Data/Game2.dcb');
    if (!existsSync(dcb)) throw new Error('Game2.dcb not found after extraction');

    await step('Export DataCore records', async () => {
      for (const filter of DCB_FILTERS) {
        const out = await starbreaker(bin, ['dcb', 'extract', '--dcb', dcb, '-o', recordsDir, '--format', 'json', '--filter', filter]);
        exported[filter] = exportedCount(out);
      }
    });
  }

  const localizations = await step('Parse localization', () => {
    const map = new Map<string, Map<string, string>>();
    const locDir = join(work, 'Data/Localization');
    for (const folder of existsSync(locDir) ? readdirSync(locDir) : []) {
      const file = join(locDir, folder, 'global.ini');
      const lang = LANGUAGE_CODES[folder];
      if (!lang || !existsSync(file)) continue;
      map.set(lang, parseGlobalIni(readFileSync(file, 'utf8')));
    }
    return map;
  });
  if (!localizations.has('en')) throw new Error('English global.ini missing');

  const store = new RecordStore(recordsDir);
  const containers = await step('Scan object containers', () => {
    const providers = new Set(store.list(MINING_PATHS.providers).map((p) => store.get(p)!._RecordId_));
    const dir = join(work, CONTAINER_DIR);
    const files = existsSync(dir) ? readdirSync(dir, { recursive: true, encoding: 'utf8' }).filter((f) => f.endsWith('.socpak')).map((f) => join(dir, f)) : [];
    if (!files.length) throw new Error(`No object containers in ${dir}`);
    return { files: files.length, ...scanContainerFiles(files, providers) };
  });

  const snapshot = await step('Normalize', () =>
    normalize({ store, localizations, game, extractor: { version: pkg.version, starbreaker: sbVersion }, containers }));

  await step('Validate snapshot', () => {
    const result = snapshotSchema.safeParse(snapshot);
    if (!result.success) throw new Error(`Snapshot failed validation:\n${result.error.message}`);
  });

  const out = resolve(args.out ?? join('local/snapshots', `catalog-${channel.toLowerCase()}-${build}.json.gz`));
  const json = JSON.stringify(snapshot);
  await step('Write snapshot', () => {
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, out.endsWith('.gz') ? gzipSync(json) : json);
  });
  if (!args['keep-work'] && !reuse) rmSync(work, { recursive: true, force: true });

  // --- metrics ---
  const byCode = new Map<string, number>();
  for (const a of snapshot.anomalies) byCode.set(a.code, (byCode.get(a.code) ?? 0) + 1);
  const blueprintCount = snapshot.blueprints.length;
  console.log('\nExported records:');
  for (const [filter, n] of Object.entries(exported)) console.log(`  ${String(n ?? '?').padStart(7)}  ${filter}`);
  console.log('\nSnapshot:');
  const rows: [string, number][] = [
    ['raw records', snapshot.rawRecords.length],
    ['resources', snapshot.resources.length],
    ['  of which ores', snapshot.resources.filter((r) => r.isOre).length],
    ['manufacturers', snapshot.manufacturers.length],
    ['items', snapshot.items.length],
    ['blueprint categories', snapshot.blueprintCategories.length],
    ['crafted properties', snapshot.craftedProperties.length],
    ['quality quantizations', snapshot.qualityQuantizations.length],
    ['blueprints', blueprintCount],
    ['  default', snapshot.blueprints.filter((b) => b.isDefault).length],
    ['  without output', snapshot.blueprints.filter((b) => !b.outputItemUuid).length],
    ['  "N of M slots"', snapshot.blueprints.filter((b) => b.tiers.some((t) => t.requiredSlots !== t.slots.length)).length],
    ['blueprint inputs', snapshot.blueprints.reduce((n, b) => n + b.tiers.reduce((m, t) => m + t.slots.reduce((k, s) => k + s.inputs.length, 0), 0), 0)],
    ['locations', snapshot.locations.length],
    ['  stations', snapshot.locations.filter((l) => l.navIcon === 'Station').length],
    ['  landing zones', snapshot.locations.filter((l) => l.navIcon === 'LandingZone').length],
    ['object containers', containers.files],
    ['  not placed (providers left out)', containers.unplaced.length],
    ['mining providers', snapshot.miningProviders.length],
    ['mineables', snapshot.mineables.length],
  ];
  for (const [label, n] of rows) console.log(`  ${String(n).padStart(7)}  ${label}`);
  console.log('\nLocalization (keys with text):');
  for (const [lang, texts] of Object.entries(snapshot.localization)) console.log(`  ${String(Object.keys(texts).length).padStart(7)}  ${lang}`);
  console.log(`\nAnomalies: ${snapshot.anomalies.length}`);
  for (const [code, n] of [...byCode].sort()) console.log(`  ${String(n).padStart(7)}  ${code}`);
  for (const a of snapshot.anomalies.filter((x) => x.code !== 'null_entries').slice(0, 15)) {
    console.log(`           - ${a.code}: ${a.record ?? '-'}: ${a.detail}`);
  }
  for (const a of snapshot.anomalies.filter((x) => x.code === 'null_entries')) console.log(`           - ${a.detail}`);
  const size = statSync(out).size;
  console.log(`\nWrote ${out} (${(size / 1024 / 1024).toFixed(1)} MB, ${(json.length / 1024 / 1024).toFixed(1)} MB uncompressed)`);
  console.log(`Timings: ${timings.map(([l, ms]) => `${l} ${(ms / 1000).toFixed(1)}s`).join(' | ')}`);
}

main().catch((err: unknown) => {
  console.error(`\nExtraction failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
