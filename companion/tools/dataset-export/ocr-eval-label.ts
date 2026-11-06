// Labels for the real tooltip line crops of sc-ohseearr's recognizer evaluation (its training/README.md),
// from sources independent of the OCR: a title = the English catalog name of the item it resolves to, a
// description line = the nearest word span of the English description (the player's global.ini), a stat line
// = the stat name from the catalog + the value read.
//
// node tools/dataset-export/ocr-eval-label.ts --catalog <en.json> [--catalog <de.json> ...] --pack <global.ini>
//     [--dir local/ocr-eval] [--out <labels.tsv>]
//
// --catalog  the web app's GET /api/companion/catalog response of one language, or the companion's kept copy of it
//            (app data folder, api/_api_catalog_lang_en.json: { etag, body }). Repeat it for more languages; the
//            FIRST one must be English (it gives the item and stat names). The item type, the component flag,
//            the stats and the name keys come from it.
// --pack     the player's global.ini (prefixes like "Mil/3/A", own descriptions); keys are lower case, a ",P" suffix drops
//            Descriptions come from the pack alone: the item's own entry (item_name_x -> item_desc_x). Variant items
//            carry arbitrary description keys; for those the pack's nearby entries are compared and the item's
//            description lines are labelled only when one entry clearly contains the most of its reads. Ambiguous
//            variants are skipped (a missing label is fine in an eval set, a wrong one is not).
// --dir      holds index.tsv (default: local/ocr-eval of this checkout)
// --out      default: <dir>/labels.tsv
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildComponentCatalog, findComponents, parseField } from '../../src/components.ts';
import { norm } from '../../src/shared/lib/stock/material-names.ts';
import type { CompanionCatalogResponse } from '../../src/shared/lib/webapp/api-types.ts';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const args = process.argv.slice(2);
const opts = (name: string) => args.flatMap((a, i) => (a === name && args[i + 1] ? [args[i + 1]!] : []));
const DIR = opts('--dir')[0] ?? `${ROOT}local/ocr-eval`;
const OUT = opts('--out')[0] ?? `${DIR}/labels.tsv`;
const PACK = opts('--pack')[0];
const catalogFiles = opts('--catalog');
if (!PACK || !catalogFiles.length) throw new Error('usage: --catalog <en.json> [--catalog <other.json> ...] --pack <global.ini> [--dir <dir>] [--out <labels.tsv>]');

const responses: CompanionCatalogResponse[] = catalogFiles.map((f) => {
  const j = JSON.parse(readFileSync(f, 'utf8'));
  return j.body?.materials ? j.body : j;
});
const nameEn = new Map<string, string>();
const statEn = new Map<string, string>();
const nameKeyOf = new Map<string, string>();
for (const m of responses[0]!.materials) {
  nameEn.set(m.uuid, m.name);
  if (m.nameKey) nameKeyOf.set(m.uuid, m.nameKey.toLowerCase());
  for (const s of m.stats) statEn.set(s.uuid, s.name);
}
// The texts the game showed in the recordings: the player's language pack, keys lower case, a ",P" suffix dropped
const pack = new Map<string, string>();
for (const line of readFileSync(PACK, 'utf8').split(/\r?\n/)) {
  const eq = line.indexOf('=');
  if (eq > 0) pack.set(line.slice(0, eq).replace(/,P$/i, '').trim().toLowerCase(), line.slice(eq + 1));
}
// The catalog export carries the name key but not the description key: derived from it
// ("item_name_x" -> "item_desc_x", "x_name" -> "x_desc"), looked up in the pack
const descKeyOf = (nameKey: string) => nameKey.replace(/^item_name/, 'item_desc').replace(/_name$/, '_desc');
// uuid -> candidate description texts (the item's own entry; else its siblings' in the pack)
const desc = new Map<string, string[]>();
const ownless = new Map<string, string>(); // uuid -> derived description key, no entry of its own
const descKeys = [...pack.keys()].filter((k) => k.includes('desc'));
const commonPrefix = (a: string, b: string) => { let i = 0; while (i < a.length && a[i] === b[i]) i++; return i; };
for (const [uuid, nameKey] of nameKeyOf) {
  const text = pack.get(descKeyOf(nameKey));
  if (text) desc.set(uuid, [text]);
  else ownless.set(uuid, descKeyOf(nameKey));
  const name = pack.get(nameKey);
  if (name) nameEn.set(uuid, name);
}
const cat = buildComponentCatalog(responses, {});

function lev(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length]!;
}
const PREFIX = /^[A-Za-z]{2,3}\/(\d+)\/([A-Za-z])\s*(.+)$/;
const loose = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').replace(/[LI]/g, '1').replace(/O/g, '0');
const looseNames = new Map<string, Set<string>>();
for (const c of cat.components) for (const n of c.names) looseNames.set(loose(n), (looseNames.get(loose(n)) ?? new Set()).add(c.uuid));

/** The item a title means: findComponents, else the fuzzy rule (distance ≤ len/8+1, margin 2). */
function itemOf(title: string): string | null {
  const hits = findComponents(cat, title);
  if (hits.length === 1) return hits[0]!.uuid;
  if (hits.length > 1) return null;
  const p = PREFIX.exec(title.trim());
  const key = loose(norm(p ? p[3]! : title));
  const ranked = [...looseNames].map(([k, u]) => ({ u, d: lev(key, k) })).sort((a, b) => a.d - b.d);
  const [a, b] = ranked;
  return a && a.u.size === 1 && a.d <= Math.floor(key.length / 8) + 1 && (!b || b.d - a.d >= 2) ? [...a.u][0]! : null;
}

// Comparison form: whitespace collapsed
const squash = (s: string) => s.replace(/\s+/g, ' ').trim();
// Characters outside the 320 charset mapped to what the model can read
const charset = (s: string) => s.replace(/[’‘]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, '-').replace(/…/g, '...');
const digits = (s: string) => s.replace(/\D/g, '');
const FIXED = ['Registered To You'];

/** The word span of the description (within one paragraph) closest to `read`. */
function spanOfAny(texts: string[], read: string): { label: string; d: number } | null {
  const found = texts.map((t) => spanOf(t, read)).filter((x) => x !== null).sort((a, b) => a.d - b.d);
  const [a, b] = found;
  return a && !(b && b.d === a.d && b.label !== a.label) ? a : null;
}
function spanOf(text: string, read: string): { label: string; d: number } | null {
  const r = squash(read);
  const words = r.split(' ').length;
  const cands: { label: string; d: number }[] = FIXED.map((f) => ({ label: f, d: lev(f, r) }));
  for (const para of text.split(/\\n|\n/)) {
    // Words split after hyphens (the game breaks "professional-|grade"); glue: no space before
    const w: { t: string; glue: boolean }[] = [];
    for (const word of charset(para).split(/\s+/).filter(Boolean)) {
      word.split(/(?<=-)(?=.)/).forEach((t, k) => w.push({ t, glue: k > 0 }));
    }
    for (let i = 0; i < w.length; i++) {
      for (let n = Math.max(1, words - 2); n <= words + 5 && i + n <= w.length; n++) {
        const label = w.slice(i, i + n).map((x, k) => (k > 0 && !x.glue ? ' ' : '') + x.t).join('');
        cands.push({ label, d: lev(label, r) });
      }
    }
  }
  cands.sort((a, b) => a.d - b.d);
  const [a, b] = cands;
  if (!a || a.d > Math.max(1, Math.floor(r.length / 4))) return null;
  // Unambiguous: another span equally close does not count (the same text in two places does)
  if (b && b.d === a.d && b.label !== a.label) return null;
  return a;
}

const rows = readFileSync(`${DIR}/index.tsv`, 'utf8').trim().split('\n').map((l) => l.split('\t'));
const head = rows.shift()!;
const col = Object.fromEntries(head.map((h, i) => [h, i]));
const titleOf = new Map<string, string>();
for (const r of rows) if (r[col.kind!] === 'title') titleOf.set(`${r[col.set!]}|${r[col.frame!]}`, r[col.text!]!);
const itemCache = new Map<string, string | null>();
// Variants carry arbitrary description keys: for an item without an entry of its own, the description entries
// near its derived key (longest shared prefix, a few characters of slack) that contain the most of its read lines
const readsOf = new Map<string, Set<string>>();
const descFor = (uuid: string, reads: Set<string>): string[] | undefined => {
  const own = desc.get(uuid);
  if (own || !ownless.has(uuid)) return own;
  const want = ownless.get(uuid)!;
  let best = 0;
  for (const dk of descKeys) best = Math.max(best, commonPrefix(want, dk));
  const floor = Math.max(best - 12, 'item_desc_'.length + 3);
  const texts = [...new Set(descKeys.filter((dk) => commonPrefix(want, dk) >= floor).map((dk) => pack.get(dk)!))];
  const flat = (t: string) => squash(charset(t.replace(/\\n|\n/g, ' ')));
  const probes = [...reads].map((r) => squash(r));
  const score = (t: string) => { const ft = flat(t); return probes.filter((p) => ft.includes(p)).length; };
  // Only a text clearly ahead of every other candidate counts; else no description label for this item
  const scores = texts.map(score).sort((x, y) => y - x);
  const picked = scores[0]! > 0 && (scores.length === 1 || scores[0]! > scores[1]!) ? [texts.find((t) => score(t) === scores[0])!] : [];
  desc.set(uuid, picked);
  return picked;
};
for (const r of rows) {
  const t = titleOf.get(`${r[col.set!]}|${r[col.frame!]}`);
  if (t === undefined || r[col.kind!] === 'title') continue;
  if (!itemCache.has(t)) itemCache.set(t, itemOf(t));
  const u = itemCache.get(t);
  if (u) readsOf.set(u, (readsOf.get(u) ?? new Set()).add(r[col.text!]!));
}
const spanCache = new Map<string, { label: string; d: number } | null>();
const out = ['file\tset\tsource\td\tlabel\tread'];
const count: Record<string, number> = {};
for (const r of rows) {
  const title = titleOf.get(`${r[col.set!]}|${r[col.frame!]}`);
  if (title === undefined) continue;
  if (!itemCache.has(title)) itemCache.set(title, itemOf(title));
  const uuid = itemCache.get(title);
  if (!uuid) continue;
  const read = r[col.text!]!;
  let label: string | null = null;
  let source = '';
  let d = 0;
  if (r[col.kind!] === 'title') {
    const name = nameEn.get(uuid);
    if (name) label = charset(name).trim();
    source = 'title';
    d = label ? lev(label, read) : 0;
  } else {
    const def = cat.components.find((c) => c.uuid === uuid)!;
    const f = parseField(read);
    const stat = f && def.stats.map((s) => ({ s, d: lev(norm(statEn.get(s.uuid) ?? s.name), norm(f.label)) })).sort((a, b) => a.d - b.d)[0];
    if (f && stat && stat.d <= 2) {
      label = `${statEn.get(stat.s.uuid) ?? stat.s.name}: ${squash(f.value)}`;
      source = 'stat';
      d = stat.d;
    } else if (descFor(uuid, readsOf.get(uuid) ?? new Set())?.length) {
      const key = `${uuid}|${read}`;
      if (!spanCache.has(key)) spanCache.set(key, spanOfAny(desc.get(uuid)!, read));
      const s = spanCache.get(key);
      // The game formats numbers itself ("8K" in the description, "8000" in the tooltip): only with the same digits
      if (s && digits(s.label) === digits(read)) [label, source, d] = [s.label, 'desc', s.d];
    }
  }
  if (!label) continue;
  count[source] = (count[source] ?? 0) + 1;
  out.push([r[col.file!], r[col.set!], source, d, label, read].join('\t'));
}
writeFileSync(OUT, out.join('\n') + '\n');
console.log(`${rows.length} crops, labeled ${out.length - 1}:`, count, `items resolved ${[...itemCache.values()].filter(Boolean).length}/${itemCache.size} titles`);
