// Experiment (lokal): Labels für die echten Zeilen-Crops (index.tsv) aus unabhängigen Quellen: der Titel
// = englischer Katalogname des eindeutig erkannten Items, eine Beschreibungszeile = der nächste Wortbereich
// der englischen Beschreibung (global.ini), eine Stat-Zeile = Stat-Name aus dem Katalog + gelesener Wert.
// node --env-file-if-exists=.env companion/ocrtrain/label.ts --pack <global.ini des Spielers>  ->  local/ocr-eval/labels.tsv
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { sql } from 'drizzle-orm';
import { connect } from '../../src/db/client.ts';
import { materialCatalog } from '../../src/stock/lookup.ts';
import { getItems } from '../../src/adminapp/queries.ts';
import { buildComponentCatalog, findComponents, parseField } from '../../companion/src/components.ts';
import { norm } from '../../src/stock/material-names.ts';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const DIR = `${ROOT}local/ocr-eval`;
const { db, close } = connect(process.env.DATABASE_URL);
const responses = [];
const nameEn = new Map<string, string>();
const statEn = new Map<string, string>();
for (const lang of ['en', 'de'] as const) {
  const items = new Map((await getItems(db, lang)).map((r) => [r.uuid, r.type]));
  const mats = await materialCatalog(db, lang);
  responses.push({ materials: [...mats.values()].map((m) => ({ ...m, type: items.get(m.uuid) ?? null })) });
  if (lang === 'en') for (const m of mats.values()) {
    nameEn.set(m.uuid, m.name);
    for (const s of m.stats) statEn.set(s.uuid, s.name);
  }
}
const keyRows = (await db.execute(sql`
  SELECT i.uuid::text AS uuid, lower(i.name_key) AS name_key, lower(i.description_key) AS desc_key, l.value AS text FROM catalog.item i
  LEFT JOIN catalog.localization_effective l ON l.key = lower(i.description_key) AND l.lang = 'en'`)) as unknown as { uuid: string; name_key: string | null; desc_key: string | null; text: string | null }[];
await close();
// Die Texte, die das Spiel bei den Aufnahmen zeigte: das Sprachpaket des Spielers (Präfixe wie "Mil/3/A",
// eigene Beschreibungen), Schlüssel klein, ein ",P"-Suffix fällt weg; sonst die englischen Texte der DB
const packAt = process.argv.indexOf('--pack');
const PACK = packAt > 0 ? process.argv[packAt + 1] : undefined;
if (!PACK) throw new Error('--pack <global.ini> fehlt');
const pack = new Map<string, string>();
for (const line of readFileSync(PACK, 'utf8').split(/\r?\n/)) {
  const eq = line.indexOf('=');
  if (eq > 0) pack.set(line.slice(0, eq).replace(/,P$/i, '').trim().toLowerCase(), line.slice(eq + 1));
}
const desc = new Map<string, string>();
for (const r of keyRows) {
  const text = (r.desc_key && pack.get(r.desc_key)) ?? r.text;
  if (text) desc.set(r.uuid, text);
  const name = r.name_key && pack.get(r.name_key);
  if (name) nameEn.set(r.uuid, name);
}
const cat = buildComponentCatalog(responses as never, {});

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

// Vergleichsform: Leerzeichen zusammengefasst
const squash = (s: string) => s.replace(/\s+/g, ' ').trim();
// Zeichen außerhalb des 320er-Zeichensatzes auf das, was das Modell lesen kann
const charset = (s: string) => s.replace(/[’‘]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, '-').replace(/…/g, '...');
const digits = (s: string) => s.replace(/\D/g, '');
const FIXED = ['Registered To You'];

/** Der Wortbereich der Beschreibung (innerhalb eines Absatzes), der `read` am nächsten ist. */
function spanOf(text: string, read: string): { label: string; d: number } | null {
  const r = squash(read);
  const words = r.split(' ').length;
  const cands: { label: string; d: number }[] = FIXED.map((f) => ({ label: f, d: lev(f, r) }));
  for (const para of text.split(/\\n|\n/)) {
    // Wörter, nach Bindestrichen geteilt (das Spiel trennt "professional-|grade"); glue: ohne Leerzeichen davor
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
  // Eindeutig: ein anderer Bereich gleich nah zählt nicht (gleicher Text an zwei Stellen schon)
  if (b && b.d === a.d && b.label !== a.label) return null;
  return a;
}

const rows = readFileSync(`${DIR}/index.tsv`, 'utf8').trim().split('\n').map((l) => l.split('\t'));
const head = rows.shift()!;
const col = Object.fromEntries(head.map((h, i) => [h, i]));
const titleOf = new Map<string, string>();
for (const r of rows) if (r[col.kind!] === 'title') titleOf.set(`${r[col.set!]}|${r[col.frame!]}`, r[col.text!]!);
const itemCache = new Map<string, string | null>();
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
    } else if (desc.has(uuid)) {
      const key = `${uuid}|${read}`;
      if (!spanCache.has(key)) spanCache.set(key, spanOf(desc.get(uuid)!, read));
      const s = spanCache.get(key);
      // Zahlen formatiert das Spiel selbst ("8K" in der Beschreibung, "8000" im Tooltip): nur bei gleichen Ziffern
      if (s && digits(s.label) === digits(read)) [label, source, d] = [s.label, 'desc', s.d];
    }
  }
  if (!label) continue;
  count[source] = (count[source] ?? 0) + 1;
  out.push([r[col.file!], r[col.set!], source, d, label, read].join('\t'));
}
writeFileSync(`${DIR}/labels.tsv`, out.join('\n') + '\n');
console.log(`${rows.length} crops, labeled ${out.length - 1}:`, count, `items resolved ${[...itemCache.values()].filter(Boolean).length}/${itemCache.size} titles`);
