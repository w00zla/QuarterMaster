// `pnpm data:pack`: builds a data release (the four assets) into a folder. No database, no network.
import { parseArgs } from 'node:util';
import { buildRelease } from './build.ts';

const HELP = `Usage: pnpm data:pack --snapshot <file> --thumbs <dir> --n <number> --out <dir> [--previous <dir>]

  --snapshot <file>   a v7 snapshot (.json or .json.gz), full or slim
  --thumbs <dir>      the thumbnails folder (thumbs.json, s/, m/, l/)
  --n <number>        re-issue number for this game version (1, 2, ...)
  --previous <dir>    the predecessor release's assets (manifest.json, thumbs-update.zip); none = first release
  --out <dir>         where the four assets go`;

try {
  const { values: a } = parseArgs({
    options: {
      snapshot: { type: 'string' }, thumbs: { type: 'string' }, n: { type: 'string' }, previous: { type: 'string' }, out: { type: 'string' },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  if (a.help || !a.snapshot || !a.thumbs || !a.n || !a.out) {
    console.log(HELP);
    process.exit(a.help ? 0 : 1);
  }
  const started = performance.now();
  const r = buildRelease({ snapshotFile: a.snapshot, thumbsDir: a.thumbs, n: Number(a.n), previousDir: a.previous, outDir: a.out });
  console.log(`tag: ${r.tag}${r.manifest.previous ? ` (previous ${r.manifest.previous})` : ' (first release)'}`);
  for (const asset of r.assets) {
    console.log(`${asset.name.padEnd(48)} ${asset.size.toLocaleString('en-US').padStart(14)} bytes  sha256 ${asset.sha256}`);
  }
  console.log(`thumbnails: ${r.thumbs.added} of ${r.thumbs.total} pictures are new${r.manifest.previous ? '' : ' (no predecessor: all)'}`);
  console.log(`built in ${((performance.now() - started) / 1000).toFixed(1)} s -> ${r.outDir}`);
} catch (err) {
  console.error(`Build failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
