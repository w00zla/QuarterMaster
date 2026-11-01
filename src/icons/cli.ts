// Rendert Icons für alle Gear-Items der App (Schiffskomponenten + FPS-Ausrüstung, dieselbe Regel wie der
// Stock-Service), für die Sammelobjekte und für Rohstoffe mit Thumbnail-Entity (roh und raffiniert teilen sich den Brocken).
// Pipeline je Block: StarBreaker (eigener Fork starbreaker-qm) `entity export-batch` (decomposed, ein Prozess je
// Block) -> scene.blend je Entity -> Blender headless (src/icons/render.py, StarBreaker-Addon) mit Pose und
// Licht-Rig des Spiels aus dem DataCore (`PlayerChoice_PITConfig.inventoryParams`, `inventorylightgroup_*`)
// -> PNG je Katalog-UUID. Der nächste Block exportiert, während der vorige rendert.
// Usage: pnpm icons:render [--sample n] [--filter <substring>] [--force] [--size 256] [--dry-run]
//        [--p4k <Data.p4k>] [--starbreaker <bin>] [--blender <bin>] [--out local/icons] [--work local/work/icons]
// Auf einem anderen Rechner ohne DB und Repo (scripts/icons-bundle.ps1 packt alles): --targets <targets.json>
// mit der Zielliste, die --write-targets hier aus der DB schreibt; die DB-Module werden dann nicht geladen.
import { execFile, spawn } from 'node:child_process';
import { appendFileSync, copyFileSync, createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, promisify } from 'node:util';

const exec = promisify(execFile);
const HELP = `Usage: pnpm icons:render [options]
  --sample <n>          Nur n Entities, reihum je eine pro Typ (Testlauf)
  --filter <substring>  Nur Entities, deren Klassenname den Text enthält (case-insensitive)
  --force               Vorhandene Exporte und Renders neu erzeugen
  --size <px>           Kantenlänge (default 256)
  --dry-run             Nur auflisten, was gerendert würde
  --p4k <path>          Data.p4k (default: $SC_DATA_P4K)
  --starbreaker <bin>   StarBreaker-CLI, eigener Fork (default: local/starbreaker-qm/starbreaker[.exe])
  --blender <bin>       Blender (default: local/blender/*/blender.exe)
  --targets <file>      Zielliste aus --write-targets statt der DB (Bundle auf einem anderen Rechner)
  --write-targets <file> Zielliste aus der DB schreiben und beenden
  --out <dir>           Ziel, ein PNG je UUID (default: local/icons)
  --work <dir>          Arbeitsverzeichnis: DataCore-Dumps, Exporte, Renders (default: local/work/icons)
  --chunk <n>           Entities je Block: ein StarBreaker- und ein Blender-Prozess (default 50)`;

interface Category { type: string; subType: string; requiredTag: unknown }
// names: Klarname je UUID (gleiche Reihenfolge) für die Dateinamen; fehlt in targets.json von vor 2026-10-26
interface Target { uuids: string[]; names?: string[]; entity: string; type: string; subType: string; worn: boolean }
interface Job { src: string; out: string; pose: number[]; rig: string; size: number }
interface Vec3 { x: number; y: number; z: number }
interface LightRecord {
  _RecordName_: string;
  _RecordValue_: { Components: { _Type_: string; lightItems?: {
    name: string;
    attachmentImplementation?: { offset?: { Position: Vec3; Rotation: Vec3 } };
    lightParams: {
      active: boolean; lightType: string;
      sizeParams?: { lightRadius: number; bulbRadius: number };
      projectorParams?: { FOV: number };
      shadowParams?: { shadowCasting: boolean };
      defaultState: { color: { r: number; g: number; b: number }; intensity: number };
    };
  }[] }[] };
}
interface PitConfig {
  _RecordValue_: { inventoryParams: {
    defaultOrientation: Vec3;
    listOfItemsOrientationOffset: { orientationOffset: Vec3; itemCategories: Category[] }[];
    listOfItemLightGroups: { lightGroupEntityClass: string; itemCategories: Category[] }[];
    defaultLightGroupEntityClass: string;
  } };
}

const DEFAULT_RIG = 'inventorylightgroup_other';
const LIGHT_GROUPS_PATH = 'libs/foundry/records/entities/lights/scene/inventory';

// Logfile im Arbeitsverzeichnis (render.log, wird fortgeschrieben): alles, was die Konsole zeigt, dazu die
// vollständigen Fehlermeldungen (fileOnly). Blenders eigene Ausgabe geht nach blender.log.
let logFile: string | undefined;
function log(line: string, fileOnly = false) {
  if (!fileOnly) console.log(line);
  if (logFile) appendFileSync(logFile, `${line}\n`);
}

async function run(bin: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  try {
    return await exec(bin, args, { maxBuffer: 256 * 1024 * 1024 });
  } catch (err) {
    const e = err as { stderr?: string; stdout?: string; message: string };
    throw new Error(`${bin} ${args.join(' ')} failed: ${(e.stderr || e.stdout || e.message).trim().slice(-2000)}`);
  }
}

function findBlender(): string {
  const root = resolve('local/blender');
  const exe = process.platform === 'win32' ? 'blender.exe' : 'blender';
  if (existsSync(root)) {
    for (const d of readdirSync(root)) {
      if (existsSync(join(root, d, exe))) return join(root, d, exe);
    }
  }
  throw new Error('Blender not found (local/blender/*/blender.exe or --blender)');
}

/** Bester Eintrag der Spiel-Tabellen für Typ/SubTyp: exakt vor Typ+UNDEFINED; Einträge mit Tag-Bedingung
 * werden übersprungen (Tags kennen wir nicht), bei Gleichstand gewinnt der erste. */
function best<T extends { itemCategories: Category[] }>(entries: T[], type: string, subType: string): T | undefined {
  let found: T | undefined;
  let score = 0;
  for (const e of entries) {
    for (const c of e.itemCategories) {
      if (c.requiredTag || c.type !== type) continue;
      const s = c.subType === subType ? 2 : c.subType === 'UNDEFINED' ? 1 : 0;
      if (s > score) {
        score = s;
        found = e;
      }
    }
  }
  return found;
}

/** Pose- und Licht-Tabellen des Inventars plus die Rigs, aus dem DataCore (gecacht im Arbeitsverzeichnis). */
async function loadGameTables(bin: string, p4k: string, work: string, force: boolean) {
  const dir = join(work, 'dcb');
  const configFile = join(dir, 'pitconfig.json');
  const groupsDir = join(dir, 'lightgroups');
  mkdirSync(join(dir, 'rigs'), { recursive: true });
  if (force || !existsSync(configFile)) {
    log('DataCore: Inventar-Tabellen lesen (PlayerChoice_PITConfig) …');
    const { stdout } = await run(bin, ['dcb', 'query', '--p4k', p4k, 'PlayerChoice_PITConfig']);
    writeFileSync(configFile, stdout);
  }
  if (force || !existsSync(groupsDir)) {
    log('DataCore: Licht-Rigs lesen (inventorylightgroup_*) …');
    await run(bin, ['dcb', 'extract', '--p4k', p4k, '--format', 'json', '-o', groupsDir, '--filter', `${LIGHT_GROUPS_PATH}/**`]);
  }
  const params = (JSON.parse(readFileSync(configFile, 'utf8')) as PitConfig)._RecordValue_.inventoryParams;
  const groupName = (ref: string) => ref.replace(/^.*\//, '').replace(/\.json$/, '').toLowerCase();

  // Rigs: je Gruppe ein kompaktes JSON für render.py
  const recordsDir = join(groupsDir, LIGHT_GROUPS_PATH);
  const rigs = new Map<string, string>();
  for (const f of readdirSync(recordsDir)) {
    const record = JSON.parse(readFileSync(join(recordsDir, f), 'utf8')) as LightRecord;
    const comp = record._RecordValue_.Components.find((c) => c._Type_ === 'SLightGroupComponentParams');
    const lights = (comp?.lightItems ?? []).map((li) => {
      const off = li.attachmentImplementation?.offset;
      const lp = li.lightParams;
      return {
        name: li.name.replace(/^SLightItem_/, ''),
        type: lp.lightType,
        active: lp.active,
        position: off ? [off.Position.x, off.Position.y, off.Position.z] : null,
        rotation: off ? [off.Rotation.x, off.Rotation.y, off.Rotation.z] : null,
        color: [lp.defaultState.color.r, lp.defaultState.color.g, lp.defaultState.color.b],
        intensity: lp.defaultState.intensity,
        radius: lp.sizeParams?.lightRadius,
        bulb: lp.sizeParams?.bulbRadius,
        fov: lp.projectorParams?.FOV,
        shadows: lp.shadowParams?.shadowCasting ?? false,
      };
    });
    const name = f.replace(/\.json$/, '').toLowerCase();
    const file = join(dir, 'rigs', `${name}.json`);
    writeFileSync(file, JSON.stringify({ record: record._RecordName_, lights }, null, 1));
    rigs.set(name, file);
  }
  const base = params.defaultOrientation;
  return {
    pose(type: string, subType: string): number[] {
      const o = best(params.listOfItemsOrientationOffset, type, subType)?.orientationOffset ?? { x: 0, y: 0, z: 0 };
      return [base.x + o.x, base.y + o.y, base.z + o.z];
    },
    rig(type: string, subType: string): string {
      const ref = best(params.listOfItemLightGroups, type, subType)?.lightGroupEntityClass ?? params.defaultLightGroupEntityClass;
      const file = rigs.get(groupName(ref)) ?? rigs.get(DEFAULT_RIG);
      if (!file) throw new Error(`light rig ${groupName(ref)} not found`);
      return file;
    },
  };
}

/** Die Items und Rohstoffe, die die App zeigt, gruppiert nach Entity (Rohstoffe teilen sich Brocken). */
async function loadTargets(): Promise<Target[]> {
  const [{ sql }, { connect }, { componentItemSql }, { locText }, { shopItemSql }] = await Promise.all([
    import('drizzle-orm'), import('../db/client.ts'), import('../stock/service.ts'), import('../db/query.ts'),
    import('../catalog/components.ts'),
  ]);
  const { db, close } = connect(process.env.DATABASE_URL);
  try {
    // Gear plus Sammelobjekte (Rezept-Inputs wie Hadanit): dieselbe Bookable-Regel wie der Stock-Service; dazu die
    // Shop-Items (Kleidung, Essen, …), deren Thumbnails der Item-Finder zeigt
    const items = (await db.execute(sql`SELECT i.uuid, i.class_name, i.type, i.sub_type,
        coalesce(${locText('en', sql`i.name_key`)}, i.class_name) AS name FROM catalog.item i
      WHERE i.retired_at IS NULL AND (EXISTS (SELECT 1 FROM catalog.blueprint_input bi WHERE bi.item_uuid = i.uuid)
        OR ${componentItemSql('i.uuid')} OR ${sql.raw(shopItemSql('i'))}) ORDER BY i.type, i.sub_type, i.class_name`)) as unknown as
      { uuid: string; class_name: string; type: string; sub_type: string | null; name: string }[];
    // rttThumbnailEntityClass ist ein Dateiverweis (file://…/thumbnailentity_resource_rock_gold.json)
    const resources = (await db.execute(sql`SELECT r.uuid, r.data->>'rttThumbnailEntityClass' AS entity,
        coalesce(${locText('en', sql`r.name_key`)}, r.key) AS name
      FROM catalog.resource r WHERE r.retired_at IS NULL AND coalesce(r.data->>'rttThumbnailEntityClass', '') <> '' ORDER BY r.key`)) as unknown as
      { uuid: string; entity: string; name: string }[];
    const byEntity = new Map<string, Target>();
    for (const i of items) {
      // Rüstung und Kleidung getragen, nicht als Loot-Kiste
      const worn = i.type.startsWith('Char_Armor_') || i.type.startsWith('Char_Clothing_');
      const t = byEntity.get(i.class_name) ?? { uuids: [], names: [], entity: i.class_name, type: i.type, subType: i.sub_type ?? 'UNDEFINED', worn };
      t.uuids.push(i.uuid);
      t.names!.push(i.name);
      byEntity.set(i.class_name, t);
    }
    for (const r of resources) {
      const entity = r.entity.replace(/^.*\//, '').replace(/\.json$/, '').replace(/^EntityClassDefinition\./, '');
      const t = byEntity.get(entity) ?? { uuids: [], names: [], entity, type: 'Thumbnail', subType: 'UNDEFINED', worn: false };
      t.uuids.push(r.uuid);
      t.names!.push(r.name);
      byEntity.set(entity, t);
    }
    return [...byEntity.values()];
  } finally {
    await close();
  }
}

/** Dateiname eines Icons: Klarname, Klassenname, UUID ("P4-AR Rifle (behr_rifle_ballistic_01) <uuid>.png"),
 * damit man die Renders im Explorer auf Sicht prüfen und gezielt nachrendern kann; icons:pack liest nur die UUID. */
function iconFile(t: Target, k: number): string {
  const name = (t.names?.[k] ?? '').replace(/[<>:"/\\|?*\x00-\x1f]/g, '').trim().slice(0, 80);
  return `${name ? `${name} ` : ''}(${t.entity}) ${t.uuids[k]}.png`;
}

/** n Targets, reihum je einer pro Typ (Testlauf quer durch die Kategorien). */
function sample(targets: Target[], n: number): Target[] {
  const groups = new Map<string, Target[]>();
  for (const t of targets) groups.set(t.type, [...(groups.get(t.type) ?? []), t]);
  const out: Target[] = [];
  for (let i = 0; out.length < n; i++) {
    let any = false;
    for (const g of groups.values()) {
      if (i < g.length && out.length < n) {
        out.push(g[i]!);
        any = true;
      }
    }
    if (!any) break;
  }
  return out;
}

interface BatchResult { name: string; ok: boolean; package?: string; worn?: boolean; seconds: number; error?: string }

/** Exportiert einen Block mit einem `entity export-batch` (P4k und DataCore einmal geladen) in ein eigenes
 * Verzeichnis: Varianten teilen sich dort Meshes und Texturen (die Mesh-Datei trägt das Material im Namen).
 * Jede Ergebniszeile kommt live über onResult. Gibt die Paketverzeichnisse je Entity zurück. */
async function exportBlock(bin: string, p4k: string, root: string, block: Target[], onResult: (r: BatchResult) => void): Promise<Map<string, string>> {
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });
  const jobsFile = join(root, 'jobs.json');
  writeFileSync(jobsFile, JSON.stringify(block.map((t) => ({ name: t.entity, output: root, worn: t.worn }))));
  const packages = new Map<string, string>();
  await new Promise<void>((resolveRun, rejectRun) => {
    // --variant-tags: Lackvarianten (…_tan01) mit ihrer eigenen SubGeometry statt in der Grundfarbe;
    // --icon-files: ohne Animationen und Diagnose-Dateien
    const child = spawn(bin, ['entity', 'export-batch', jobsFile, '--p4k', p4k, '--kind', 'decomposed', '--variant-tags', '--icon-files'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let buffer = '';
    let stderr = '';
    const onLine = (line: string) => {
      if (!line.trim().startsWith('{')) return;
      const r = JSON.parse(line) as BatchResult;
      if (r.ok && r.package) packages.set(r.name, r.package);
      onResult(r);
    };
    child.stdout.on('data', (data: Buffer) => {
      buffer += data.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const l of lines) onLine(l);
    });
    child.stderr.on('data', (data: Buffer) => { stderr = (stderr + data.toString()).slice(-4000); });
    child.on('close', (code) => {
      if (buffer) onLine(buffer);
      if (code === 0) resolveRun();
      else rejectRun(new Error(`${bin} entity export-batch failed (${code}): ${stderr.trim()}`));
    });
    child.on('error', rejectRun);
  });
  return packages;
}

async function main() {
  const { values: args } = parseArgs({
    options: {
      sample: { type: 'string' },
      filter: { type: 'string' },
      targets: { type: 'string' },
      'write-targets': { type: 'string' },
      force: { type: 'boolean', default: false },
      size: { type: 'string', default: '256' },
      'dry-run': { type: 'boolean', default: false },
      p4k: { type: 'string' },
      starbreaker: { type: 'string' },
      blender: { type: 'string' },
      out: { type: 'string', default: 'local/icons' },
      work: { type: 'string', default: 'local/work/icons' },
      chunk: { type: 'string', default: '50' },
      help: { type: 'boolean', default: false },
    },
  });
  if (args.help) {
    log(HELP);
    return;
  }
  if (!args.p4k && !process.env.SC_DATA_P4K) throw new Error('No Data.p4k given (--p4k or $SC_DATA_P4K)');
  const p4k = resolve(args.p4k ?? process.env.SC_DATA_P4K ?? '');
  if (!existsSync(p4k)) throw new Error(`Data.p4k not found: ${p4k}`);
  const starbreaker = resolve(args.starbreaker ?? (process.platform === 'win32' ? 'local/starbreaker-qm/starbreaker.exe' : 'local/starbreaker-qm/starbreaker'));
  if (!existsSync(starbreaker)) throw new Error(`StarBreaker not found: ${starbreaker}`);
  const blender = args.blender ? resolve(args.blender) : findBlender();
  const renderScript = fileURLToPath(new URL('./render.py', import.meta.url));
  const out = resolve(args.out);
  const work = resolve(args.work);
  const exportRoot = join(work, 'export');
  const renderDir = join(work, 'render');
  const size = Number(args.size);
  const chunk = Number(args.chunk);
  for (const d of [out, exportRoot, renderDir]) mkdirSync(d, { recursive: true });
  logFile = join(work, 'render.log');
  log(`=== ${new Date().toISOString()} icons:render ${process.argv.slice(2).join(' ')}`, true);

  log(args.targets ? `Zielliste: ${resolve(args.targets)}` : 'Zielliste aus der DB …');
  let targets = args.targets ? (JSON.parse(readFileSync(resolve(args.targets), 'utf8')) as Target[]) : await loadTargets();
  if (args['write-targets']) {
    writeFileSync(resolve(args['write-targets']), JSON.stringify(targets, null, 1));
    log(`${targets.length} Entities -> ${resolve(args['write-targets'])}`);
    return;
  }
  const total = targets.reduce((n, t) => n + t.uuids.length, 0);
  if (args.filter) targets = targets.filter((t) => t.entity.toLowerCase().includes(args.filter!.toLowerCase()));
  if (args.sample) targets = sample(targets, Number(args.sample));
  log(`${total} Katalog-Einträge, ${targets.length} Entities zu rendern${args.sample ? ' (Sample)' : ''}`);
  const tables = await loadGameTables(starbreaker, p4k, work, args.force);
  if (args['dry-run']) {
    for (const t of targets) {
      const rig = tables.rig(t.type, t.subType).replace(/^.*[\\/]/, '').replace(/\.json$/, '');
      log(`${t.entity}  ${t.type}/${t.subType}  pose ${tables.pose(t.type, t.subType).join(',')}  ${rig}${t.worn ? '  worn' : ''}  -> ${t.uuids.length} uuid(s)`);
    }
    return;
  }

  // Blockweise: ein StarBreaker- und ein Blender-Prozess je Block; der nächste Block exportiert, während der
  // vorige rendert. So landen die ersten Icons nach Minuten, nicht nach Stunden.
  const started = Date.now();
  const failures: string[] = [];
  let exported = 0;
  let rendered = 0;
  let skipped = 0;
  const width = String(targets.length).length;
  const progress = (i: number, what: string, entity: string, note: string) =>
    log(`[${String(i).padStart(width)}/${targets.length}] ${what.padEnd(6)} ${entity}  ${note}`);
  const elapsed = () => `${Math.round((Date.now() - started) / 60000)} min`;
  log(`Blender: ${blender}`);
  const blenderLog = createWriteStream(join(work, 'blender.log'), { flags: 'a' });
  blenderLog.write(`=== ${new Date().toISOString()}\n`);

  // Icons im Ziel je UUID: ein neuer Name (Klarname geändert, alte <uuid>.png) ersetzt den alten, nie zwei je UUID
  const existing = new Map<string, string[]>();
  for (const f of readdirSync(out)) {
    const m = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.png$/i.exec(f);
    if (m) existing.set(m[1]!.toLowerCase(), [...(existing.get(m[1]!.toLowerCase()) ?? []), f]);
  }
  const placeIcons = (png: string, t: Target, onlyMissing: boolean) => {
    t.uuids.forEach((uuid, k) => {
      const file = iconFile(t, k);
      for (const old of existing.get(uuid) ?? []) if (old !== file) rmSync(join(out, old), { force: true });
      existing.set(uuid, [file]);
      if (!onlyMissing || !existsSync(join(out, file))) copyFileSync(png, join(out, file));
    });
  };

  // Schon Gerendertes bleibt (außer --force), der Rest geht blockweise durch Export und Render
  const todo: { index: number; t: Target }[] = [];
  targets.forEach((t, index) => {
    const png = join(renderDir, `${t.entity}.png`);
    if (!args.force && existsSync(png)) {
      placeIcons(png, t, true);
      skipped++;
    } else {
      todo.push({ index, t });
    }
  });
  const blocks: { index: number; t: Target }[][] = [];
  for (let b0 = 0; b0 < todo.length; b0 += chunk) blocks.push(todo.slice(b0, b0 + chunk));
  const blockRoot = (k: number) => join(exportRoot, `b${k}`);

  /** Export eines Blocks; Fehler einzelner Entities landen in failures, die Pakete je Index kommen zurück. */
  const runExport = async (k: number): Promise<Map<number, string>> => {
    const block = blocks[k]!;
    const root = blockRoot(k);
    const byName = new Map(block.map((e) => [e.t.entity.toLowerCase(), e]));
    const packages = new Map<number, string>();
    try {
      const byEntity = await exportBlock(starbreaker, p4k, root, block.map((e) => e.t), (r) => {
        const e = byName.get(r.name.toLowerCase());
        if (!e) return;
        if (r.ok) {
          exported++;
          progress(e.index + 1, 'export', e.t.entity, `${r.seconds.toFixed(1)} s${e.t.worn && !r.worn ? ' (ohne worn)' : ''}`);
        } else {
          failures.push(`${e.t.entity}: ${r.error}`);
          log(`    ${r.error}`, true);
          progress(e.index + 1, 'export', e.t.entity, 'FEHLER');
        }
      });
      for (const e of block) {
        const pkg = byEntity.get(e.t.entity);
        if (pkg) packages.set(e.index, pkg);
      }
    } catch (err) {
      for (const e of block) failures.push(`${e.t.entity}: export-batch abgebrochen`);
      log(`    ${(err as Error).message}`);
      return packages;
    }
    // Blender liest unter Windows keine Pfade über 259 Zeichen: fehlende Texturen rendern still weiß
    const tooLong = readdirSync(root, { recursive: true }).map((f) => join(root, String(f))).filter((f) => f.length > 259);
    if (tooLong.length) {
      failures.push(`Block ${k + 1}: ${tooLong.length} Pfade über 259 Zeichen (${tooLong[0]}), --work in einen kürzeren Ordner legen`);
    }
    return packages;
  };

  let nextExport = blocks.length ? runExport(0) : undefined;
  for (let k = 0; k < blocks.length; k++) {
    const packages = await nextExport!;
    nextExport = k + 1 < blocks.length ? runExport(k + 1) : undefined;
    const jobs: { index: number; target: Target; job: Job }[] = [];
    for (const { index, t } of blocks[k]!) {
      const pkg = packages.get(index);
      if (!pkg) continue;
      jobs.push({ index, target: t, job: { src: join(pkg, 'scene.blend'), out: join(renderDir, `${t.entity}.png`), pose: tables.pose(t.type, t.subType), rig: tables.rig(t.type, t.subType), size } });
    }
    if (!jobs.length) continue;

    // render.py meldet jedes Item ("icon: <png> …" / "failed: <png> …"), die Zeilen werden live zu Fortschritt
    const jobsFile = join(work, `render-jobs-b${k}.json`);
    writeFileSync(jobsFile, JSON.stringify(jobs.map((j) => j.job)));
    const byOut = new Map(jobs.map((j) => [j.job.out.toLowerCase(), j]));
    const done = new Set<string>();
    let t0 = Date.now();
    log(`Blender startet für ${jobs.length} Renders …`);
    const onLine = (line: string) => {
      const m = /^(icon|failed): (.+?\.png)(?: (.*))?$/.exec(line.trim());
      if (!m) return;
      const key = m[2]!.toLowerCase();
      const j = byOut.get(key);
      if (!j || done.has(key)) return;
      done.add(key);
      if (m[1] === 'icon') {
        progress(j.index + 1, 'render', j.target.entity, `${((Date.now() - t0) / 1000).toFixed(1)} s`);
      } else {
        progress(j.index + 1, 'render', j.target.entity, `FEHLER ${m[3] ?? ''}`);
        failures.push(`${j.target.entity}: ${m[3] ?? 'render failed'}`);
      }
      t0 = Date.now();
    };
    await new Promise<void>((resolveRun) => {
      const child = spawn(blender, ['-b', '--python', renderScript, '--', '--jobs', jobsFile], { stdio: ['ignore', 'pipe', 'pipe'] });
      let buffer = '';
      child.stdout.on('data', (data: Buffer) => {
        blenderLog.write(data);
        buffer += data.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const l of lines) onLine(l);
      });
      child.stderr.on('data', (data: Buffer) => blenderLog.write(data)); // Blenders Rauschen, Tracebacks von render.py
      child.on('close', () => {
        if (buffer) onLine(buffer);
        resolveRun();
      });
      child.on('error', (err) => {
        log(`Blender konnte nicht starten: ${err.message}`);
        resolveRun();
      });
    });
    let blockOk = jobs.length === blocks[k]!.length;
    for (const j of jobs) {
      const failed = failures.some((f) => f.startsWith(`${j.target.entity}: `));
      if (!failed && existsSync(j.job.out)) {
        rendered++;
        placeIcons(j.job.out, j.target, false);
      } else {
        blockOk = false;
        if (!failed) {
          failures.push(`${j.target.entity}: no render output (Blender abgebrochen?)`);
          progress(j.index + 1, 'render', j.target.entity, 'FEHLER kein Bild');
        }
      }
    }
    // Export des Blocks nach dem Render weg (der volle Satz wären Gigabytes); mit Fehlschlägen bleibt er zur Diagnose
    if (blockOk) rmSync(blockRoot(k), { recursive: true, force: true });
    rmSync(jobsFile, { force: true });
    log(`Block ${k + 1}/${blocks.length} fertig: ${rendered} gerendert, ${skipped} übersprungen, ${failures.length} Fehler, ${elapsed()}`);
  }
  log(`Fertig: ${rendered} gerendert, ${skipped} übersprungen, ${exported} exportiert, ${failures.length} Fehler, ${elapsed()} -> ${out}`);
  for (const f of failures) log(`  ! ${f}`);
  blenderLog.end();
  if (failures.length) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  if (logFile) appendFileSync(logFile, `${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(1);
});
