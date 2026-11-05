// Packs the rendered icons (packshot's set live, local/packshot/sets/live/[<Name> (<class>) ]<uuid>.png, 256 px;
// only the UUID at the end counts) into thumbnails for the apps: three AVIFs per UUID (s/m/l, src/thumbs.ts),
// trimmed to the content and padded square with a small border, plus thumbs.json {uuid: hash}. Hash = the first 8
// hex characters of the PNG's SHA-256: a newly rendered icon gets a new URL, unchanged ones stay in the clients'
// cache. Stale files in the target are deleted.
// Usage: pnpm thumbs:build [--in local/packshot/sets/live] [--out local/thumbs] [--force]
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import sharp from 'sharp';
import { THUMB_FILE, THUMB_SIZES, thumbFile, type ThumbSize } from '../thumbs.ts';

const HELP = `Usage: pnpm thumbs:build [options]
  --in <dir>     The PNGs, …<uuid>.png (default: local/packshot/sets/live; subfolders are not read)
  --out <dir>    Target: s/, m/, l/ and thumbs.json (default: local/thumbs)
  --force        Create existing thumbnails again`;

const PNG = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.png$/i;
// AVIF quality: measured the smallest format from 96 px up, even with WebP at 40 px
const QUALITY = 45;
const EFFORT = 6;
const SIZES = Object.keys(THUMB_SIZES) as ThumbSize[];

const { values: args } = parseArgs({
  options: {
    in: { type: 'string', default: 'local/packshot/sets/live' },
    out: { type: 'string', default: 'local/thumbs' },
    force: { type: 'boolean', default: false },
    help: { type: 'boolean', default: false },
  },
});
if (args.help) {
  console.log(HELP);
  process.exit(0);
}
const inDir = resolve(args.in);
const outDir = resolve(args.out);
if (!existsSync(inDir)) {
  console.error(`Not found: ${inDir}`);
  process.exit(1);
}
for (const size of SIZES) mkdirSync(join(outDir, size), { recursive: true });

const sources = readdirSync(inDir, { withFileTypes: true })
  .filter((d) => d.isFile() && PNG.test(d.name))
  .map((d) => ({ uuid: PNG.exec(d.name)![1]!.toLowerCase(), file: join(inDir, d.name) }));
// Two files for one UUID (an old <uuid>.png next to one with a name): which one holds cannot be decided
const seen = new Map<string, string>();
const doubles: string[] = [];
for (const s of sources) {
  const prev = seen.get(s.uuid);
  if (prev) doubles.push(`${prev} | ${s.file}`);
  else seen.set(s.uuid, s.file);
}
if (doubles.length) {
  console.error(`${doubles.length} UUIDs twice in ${inDir}, delete one file per UUID:\n  ${doubles.slice(0, 20).join('\n  ')}`);
  process.exit(1);
}
console.log(`${sources.length} Icons in ${inDir} -> ${outDir}`);

async function pack(file: string, hash: string, uuid: string) {
  // trim to the content (transparent border), then fit per size and add the border
  const trimmed = await sharp(file).trim({ threshold: 1 }).toBuffer();
  for (const size of SIZES) {
    const px = THUMB_SIZES[size];
    const pad = Math.max(2, Math.round(px / 20));
    const out = join(outDir, size, thumbFile(uuid, hash));
    if (!args.force && existsSync(out)) continue;
    const transparent = { r: 0, g: 0, b: 0, alpha: 0 };
    const avif = await sharp(trimmed)
      .resize(px - 2 * pad, px - 2 * pad, { fit: 'contain', background: transparent, kernel: 'lanczos3' })
      .extend({ top: pad, bottom: pad, left: pad, right: pad, background: transparent })
      .avif({ quality: QUALITY, effort: EFFORT })
      .toBuffer();
    writeFileSync(`${out}.tmp`, avif);
    renameSync(`${out}.tmp`, out);
  }
}

const manifest: Record<string, string> = {};
let packed = 0;
let skipped = 0;
const failures: string[] = [];
const started = Date.now();
let next = 0;
// sharp is multi-threaded itself; a few images at once still keep the cores busier
await Promise.all(Array.from({ length: Math.max(1, Math.floor(availableParallelism() / 2)) }, async () => {
  while (next < sources.length) {
    const { uuid, file } = sources[next++]!;
    const hash = createHash('sha256').update(readFileSync(file)).digest('hex').slice(0, 8);
    const done = SIZES.every((s) => existsSync(join(outDir, s, thumbFile(uuid, hash))));
    try {
      if (done && !args.force) skipped++;
      else {
        await pack(file, hash, uuid);
        packed++;
      }
      manifest[uuid] = hash;
    } catch (err) {
      failures.push(`${uuid}: ${err instanceof Error ? err.message : String(err)}`);
    }
    const n = packed + skipped + failures.length;
    if (n % 250 === 0) console.log(`${n}/${sources.length} (${((Date.now() - started) / 1000).toFixed(0)} s)`);
  }
}));

// Stale: old hashes and UUIDs that are gone
let removed = 0;
for (const size of SIZES) {
  for (const f of readdirSync(join(outDir, size))) {
    const m = THUMB_FILE.exec(f);
    if (m && manifest[m[1]!] === m[2]) continue;
    rmSync(join(outDir, size, f));
    removed++;
  }
}
const sorted = Object.fromEntries(Object.entries(manifest).sort(([a], [b]) => a.localeCompare(b)));
writeFileSync(join(outDir, 'thumbs.json.tmp'), JSON.stringify(sorted));
renameSync(join(outDir, 'thumbs.json.tmp'), join(outDir, 'thumbs.json'));

console.log(`Done: ${packed} packed, ${skipped} present, ${removed} stale files deleted, ${failures.length} failures, ${((Date.now() - started) / 1000).toFixed(0)} s`);
for (const f of failures) console.log(`  ! ${f}`);
if (failures.length) process.exit(1);
