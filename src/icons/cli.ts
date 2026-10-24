// Rendert Icons für alle Gear-Items der App (Schiffskomponenten + FPS-Ausrüstung, dieselbe Regel wie der
// Stock-Service) und für Rohstoffe mit Thumbnail-Entity (roh und raffiniert teilen sich den Brocken).
// Pipeline je Entity: StarBreaker (fleetyards-Fork) `entity export --kind decomposed` -> scene.blend ->
// Blender headless (src/icons/render.py, StarBreaker-Addon) mit Pose und Licht-Rig des Spiels aus dem
// DataCore (`PlayerChoice_PITConfig.inventoryParams`, `inventorylightgroup_*`) -> PNG je Katalog-UUID.
// Usage: pnpm icons:render [--sample n] [--filter <substring>] [--force] [--size 256] [--dry-run]
//        [--p4k <Data.p4k>] [--starbreaker <bin>] [--blender <bin>] [--out local/icons] [--work local/work/icons]
// Auf einem anderen Rechner ohne DB und Repo (scripts/icons-bundle.ps1 packt alles): --targets <targets.json>
// mit der Zielliste, die --write-targets hier aus der DB schreibt; die DB-Module werden dann nicht geladen.
import { execFile, spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
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
  --starbreaker <bin>   StarBreaker-CLI, fleetyards-Fork (default: local/starbreaker-fy/starbreaker.exe)
  --blender <bin>       Blender (default: local/blender/*/blender.exe)
  --targets <file>      Zielliste aus --write-targets statt der DB (Bundle auf einem anderen Rechner)
  --write-targets <file> Zielliste aus der DB schreiben und beenden
  --out <dir>           Ziel, ein PNG je UUID (default: local/icons)
  --work <dir>          Arbeitsverzeichnis: DataCore-Dumps, Exporte, Renders (default: local/work/icons)
  --chunk <n>           Entities je Block: erst exportieren, dann ein Blender-Prozess (default 50)
  --parallel <n>        Gleichzeitige StarBreaker-Exporte (default 4; jeder lädt die DataCore für sich)`;

interface Category { type: string; subType: string; requiredTag: unknown }
interface Target { uuids: string[]; entity: string; type: string; subType: string; worn: boolean }
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

const PACKAGE_SUFFIX = '_LOD1_TEX2';
const DEFAULT_RIG = 'inventorylightgroup_other';
const LIGHT_GROUPS_PATH = 'libs/foundry/records/entities/lights/scene/inventory';

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
    console.log('DataCore: Inventar-Tabellen lesen (PlayerChoice_PITConfig) …');
    const { stdout } = await run(bin, ['dcb', 'query', '--p4k', p4k, 'PlayerChoice_PITConfig']);
    writeFileSync(configFile, stdout);
  }
  if (force || !existsSync(groupsDir)) {
    console.log('DataCore: Licht-Rigs lesen (inventorylightgroup_*) …');
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
  const [{ sql }, { connect }, { componentItemSql }] = await Promise.all([
    import('drizzle-orm'), import('../db/client.ts'), import('../stock/service.ts'),
  ]);
  const { db, close } = connect(process.env.DATABASE_URL);
  try {
    const items = (await db.execute(sql`SELECT i.uuid, i.class_name, i.type, i.sub_type FROM catalog.item i
      WHERE i.retired_at IS NULL AND ${componentItemSql('i.uuid')} ORDER BY i.type, i.sub_type, i.class_name`)) as unknown as
      { uuid: string; class_name: string; type: string; sub_type: string | null }[];
    // rttThumbnailEntityClass ist ein Dateiverweis (file://…/thumbnailentity_resource_rock_gold.json)
    const resources = (await db.execute(sql`SELECT uuid, key, data->>'rttThumbnailEntityClass' AS entity
      FROM catalog.resource WHERE retired_at IS NULL AND coalesce(data->>'rttThumbnailEntityClass', '') <> '' ORDER BY key`)) as unknown as
      { uuid: string; key: string; entity: string }[];
    const byEntity = new Map<string, Target>();
    for (const i of items) {
      const t = byEntity.get(i.class_name) ?? { uuids: [], entity: i.class_name, type: i.type, subType: i.sub_type ?? 'UNDEFINED', worn: i.type.startsWith('Char_Armor_') };
      t.uuids.push(i.uuid);
      byEntity.set(i.class_name, t);
    }
    for (const r of resources) {
      const entity = r.entity.replace(/^.*\//, '').replace(/\.json$/, '').replace(/^EntityClassDefinition\./, '');
      const t = byEntity.get(entity) ?? { uuids: [], entity, type: 'Thumbnail', subType: 'UNDEFINED', worn: false };
      t.uuids.push(r.uuid);
      byEntity.set(entity, t);
    }
    return [...byEntity.values()];
  } finally {
    await close();
  }
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

/** Das Paketverzeichnis eines Exports: StarBreaker ersetzt Unterstriche durch Leerzeichen, die
 * Groß-/Kleinschreibung folgt dem DataCore-Namen, nicht dem gesuchten. */
function packageDir(exportRoot: string, entity: string): string | undefined {
  const wanted = `${entity.replace(/_/g, ' ')}${PACKAGE_SUFFIX}`.toLowerCase();
  const packages = join(exportRoot, 'Packages');
  if (!existsSync(packages)) return undefined;
  const hit = readdirSync(packages).find((d) => d.toLowerCase() === wanted);
  return hit ? join(packages, hit) : undefined;
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
      parallel: { type: 'string', default: '4' },
      help: { type: 'boolean', default: false },
    },
  });
  if (args.help) {
    console.log(HELP);
    return;
  }
  if (!args.p4k && !process.env.SC_DATA_P4K) throw new Error('No Data.p4k given (--p4k or $SC_DATA_P4K)');
  const p4k = resolve(args.p4k ?? process.env.SC_DATA_P4K ?? '');
  if (!existsSync(p4k)) throw new Error(`Data.p4k not found: ${p4k}`);
  const starbreaker = resolve(args.starbreaker ?? 'local/starbreaker-fy/starbreaker.exe');
  if (!existsSync(starbreaker)) throw new Error(`StarBreaker not found: ${starbreaker}`);
  const blender = args.blender ? resolve(args.blender) : findBlender();
  const renderScript = fileURLToPath(new URL('./render.py', import.meta.url));
  const out = resolve(args.out);
  const work = resolve(args.work);
  const exportRoot = join(work, 'export');
  const renderDir = join(work, 'render');
  const size = Number(args.size);
  const chunk = Number(args.chunk);
  const parallel = Math.max(1, Number(args.parallel));
  for (const d of [out, exportRoot, renderDir]) mkdirSync(d, { recursive: true });

  console.log(args.targets ? `Zielliste: ${resolve(args.targets)}` : 'Zielliste aus der DB …');
  let targets = args.targets ? (JSON.parse(readFileSync(resolve(args.targets), 'utf8')) as Target[]) : await loadTargets();
  if (args['write-targets']) {
    writeFileSync(resolve(args['write-targets']), JSON.stringify(targets, null, 1));
    console.log(`${targets.length} Entities -> ${resolve(args['write-targets'])}`);
    return;
  }
  const total = targets.reduce((n, t) => n + t.uuids.length, 0);
  if (args.filter) targets = targets.filter((t) => t.entity.toLowerCase().includes(args.filter!.toLowerCase()));
  if (args.sample) targets = sample(targets, Number(args.sample));
  console.log(`${total} Katalog-Einträge, ${targets.length} Entities zu rendern${args.sample ? ' (Sample)' : ''}`);
  const tables = await loadGameTables(starbreaker, p4k, work, args.force);
  if (args['dry-run']) {
    for (const t of targets) {
      const rig = tables.rig(t.type, t.subType).replace(/^.*[\\/]/, '').replace(/\.json$/, '');
      console.log(`${t.entity}  ${t.type}/${t.subType}  pose ${tables.pose(t.type, t.subType).join(',')}  ${rig}${t.worn ? '  worn' : ''}  -> ${t.uuids.length} uuid(s)`);
    }
    return;
  }

  // Blockweise: einen Block exportieren (StarBreaker nutzt selbst alle Kerne, daher nacheinander), dann
  // rendern (ein Blender-Prozess je Block). So landen die ersten Icons nach Minuten, nicht nach Stunden.
  const started = Date.now();
  const failures: string[] = [];
  let exported = 0;
  let rendered = 0;
  let skipped = 0;
  const width = String(targets.length).length;
  const progress = (i: number, what: string, entity: string, note: string) =>
    console.log(`[${String(i).padStart(width)}/${targets.length}] ${what.padEnd(6)} ${entity}  ${note}`);
  const elapsed = () => `${Math.round((Date.now() - started) / 60000)} min`;
  console.log(`Blender: ${blender}`);

  for (let b0 = 0; b0 < targets.length; b0 += chunk) {
    const jobs: { index: number; target: Target; job: Job }[] = [];
    // Exporte parallel: jeder StarBreaker-Aufruf lädt erst die DataCore (~2 s), das überlappt so
    const block = targets.slice(b0, Math.min(b0 + chunk, targets.length)).map((t, k) => ({ index: b0 + k, t }));
    const packages = new Map<number, string>();
    let next = 0;
    const exportOne = async (i: number, t: Target) => {
      const png = join(renderDir, `${t.entity}.png`);
      if (!args.force && existsSync(png)) {
        for (const uuid of t.uuids) if (!existsSync(join(out, `${uuid}.png`))) copyFileSync(png, join(out, `${uuid}.png`));
        skipped++;
        return;
      }
      let pkg = packageDir(exportRoot, t.entity);
      if (args.force || !pkg) {
        const base = ['entity', 'export', '--p4k', p4k, t.entity, exportRoot, '--kind', 'decomposed'];
        const t0 = Date.now();
        try {
          try {
            await run(starbreaker, t.worn ? [...base, '--worn'] : base);
          } catch (err) {
            if (!t.worn) throw err;
            await run(starbreaker, base); // kein getragenes Modell: das Standardmodell nehmen
          }
          exported++;
          progress(i + 1, 'export', t.entity, `${((Date.now() - t0) / 1000).toFixed(1)} s`);
        } catch (err) {
          failures.push(`${t.entity}: ${(err as Error).message.split('\n').pop()}`);
          progress(i + 1, 'export', t.entity, 'FEHLER');
          return;
        }
        pkg = packageDir(exportRoot, t.entity);
        if (!pkg) {
          failures.push(`${t.entity}: package directory not found after export`);
          progress(i + 1, 'export', t.entity, 'FEHLER kein Paketverzeichnis');
          return;
        }
      } else {
        progress(i + 1, 'export', t.entity, 'vorhanden');
      }
      packages.set(i, pkg);
    };
    await Promise.all(Array.from({ length: Math.min(parallel, block.length) }, async () => {
      while (next < block.length) {
        const { index, t } = block[next++]!;
        await exportOne(index, t);
      }
    }));
    for (const { index, t } of block) {
      const pkg = packages.get(index);
      if (!pkg) continue;
      jobs.push({ index, target: t, job: { src: join(pkg, 'scene.blend'), out: join(renderDir, `${t.entity}.png`), pose: tables.pose(t.type, t.subType), rig: tables.rig(t.type, t.subType), size } });
    }
    if (!jobs.length) continue;

    // render.py meldet jedes Item ("icon: <png> …" / "failed: <png> …"), die Zeilen werden live zu Fortschritt
    const jobsFile = join(work, 'jobs.json');
    writeFileSync(jobsFile, JSON.stringify(jobs.map((j) => j.job)));
    const byOut = new Map(jobs.map((j) => [j.job.out.toLowerCase(), j]));
    const done = new Set<string>();
    let t0 = Date.now();
    console.log(`Blender startet für ${jobs.length} Renders …`);
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
        buffer += data.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const l of lines) onLine(l);
      });
      child.stderr.on('data', () => {}); // Blenders eigenes Rauschen
      child.on('close', () => {
        if (buffer) onLine(buffer);
        resolveRun();
      });
      child.on('error', (err) => {
        console.log(`Blender konnte nicht starten: ${err.message}`);
        resolveRun();
      });
    });
    for (const j of jobs) {
      const failed = failures.some((f) => f.startsWith(`${j.target.entity}: `));
      if (!failed && existsSync(j.job.out)) {
        rendered++;
        for (const uuid of j.target.uuids) copyFileSync(j.job.out, join(out, `${uuid}.png`));
      } else if (!failed) {
        failures.push(`${j.target.entity}: no render output (Blender abgebrochen?)`);
        progress(j.index + 1, 'render', j.target.entity, 'FEHLER kein Bild');
      }
    }
    console.log(`Block fertig: ${rendered} gerendert, ${skipped} übersprungen, ${failures.length} Fehler, ${elapsed()}`);
  }
  console.log(`Fertig: ${rendered} gerendert, ${skipped} übersprungen, ${exported} exportiert, ${failures.length} Fehler, ${elapsed()} -> ${out}`);
  for (const f of failures) console.log(`  ! ${f}`);
  if (failures.length) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
