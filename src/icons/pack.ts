// Packt die gerenderten Icons (das Set live von packshot, local/packshot/sets/live/[<Name> (<class>) ]<uuid>.png,
// 256 px; nur die UUID am Ende zählt)
// zu Thumbnails für die Apps: je UUID drei
// AVIFs (s/m/l, src/thumbs.ts), auf den Inhalt beschnitten und mit etwas Rand quadratisch aufgefüllt, plus
// thumbs.json {uuid: hash}. Hash = die ersten 8 Hex-Zeichen von SHA-256 des PNGs: ein neu gerendertes Icon
// bekommt eine neue URL, unveränderte bleiben im Cache der Clients. Veraltete Dateien im Ziel werden gelöscht.
// Usage: pnpm thumbs:build [--in local/packshot/sets/live] [--out local/thumbs] [--force]
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import sharp from 'sharp';
import { THUMB_FILE, THUMB_SIZES, thumbFile, type ThumbSize } from '../thumbs.ts';

const HELP = `Usage: pnpm thumbs:build [options]
  --in <dir>     Die PNGs, …<uuid>.png (default: local/packshot/sets/live; Unterordner werden nicht gelesen)
  --out <dir>    Ziel: s/, m/, l/ und thumbs.json (default: local/thumbs)
  --force        Vorhandene Thumbnails neu erzeugen`;

const PNG = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.png$/i;
// AVIF-Qualität: gemessen das kleinste Format ab 96 px, bei 40 px gleichauf mit WebP
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
  console.error(`Nicht gefunden: ${inDir}`);
  process.exit(1);
}
for (const size of SIZES) mkdirSync(join(outDir, size), { recursive: true });

const sources = readdirSync(inDir, { withFileTypes: true })
  .filter((d) => d.isFile() && PNG.test(d.name))
  .map((d) => ({ uuid: PNG.exec(d.name)![1]!.toLowerCase(), file: join(inDir, d.name) }));
// Zwei Dateien zu einer UUID (alte <uuid>.png neben einer mit Namen): welche gilt, ist nicht zu entscheiden
const seen = new Map<string, string>();
const doubles: string[] = [];
for (const s of sources) {
  const prev = seen.get(s.uuid);
  if (prev) doubles.push(`${prev} | ${s.file}`);
  else seen.set(s.uuid, s.file);
}
if (doubles.length) {
  console.error(`${doubles.length} UUIDs doppelt in ${inDir}, eine Datei je UUID löschen:\n  ${doubles.slice(0, 20).join('\n  ')}`);
  process.exit(1);
}
console.log(`${sources.length} Icons in ${inDir} -> ${outDir}`);

async function pack(file: string, hash: string, uuid: string) {
  // Auf den Inhalt beschneiden (transparenter Rand), dann je Größe einpassen und Rand anfügen
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
// sharp rechnet selbst mehrfädig; ein paar Bilder gleichzeitig halten die Kerne trotzdem besser beschäftigt
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

// Veraltet: alte Hashes und UUIDs, die es nicht mehr gibt
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

console.log(`Fertig: ${packed} gepackt, ${skipped} vorhanden, ${removed} veraltete Dateien gelöscht, ${failures.length} Fehler, ${((Date.now() - started) / 1000).toFixed(0)} s`);
for (const f of failures) console.log(`  ! ${f}`);
if (failures.length) process.exit(1);
