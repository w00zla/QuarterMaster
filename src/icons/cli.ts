// Rendert Icons für alle Gear-Items der App (Schiffskomponenten + FPS-Ausrüstung, dieselbe Regel wie der
// Stock-Service) und für Rohstoffe mit Thumbnail-Entity (roh und raffiniert teilen sich den Brocken).
// Pipeline je Entity: StarBreaker (fleetyards-Fork) `entity export --kind decomposed` -> scene.blend ->
// Blender headless (src/icons/render.py, StarBreaker-Addon) mit Pose und Licht-Rig des Spiels aus dem
// DataCore (`PlayerChoice_PITConfig.inventoryParams`, `inventorylightgroup_*`) -> PNG je Katalog-UUID.
// Usage: pnpm icons:render [--sample n] [--filter <substring>] [--force] [--size 256] [--dry-run]
//        [--p4k <Data.p4k>] [--starbreaker <bin>] [--blender <bin>] [--out local/icons] [--work local/work/icons]
// Auf einem anderen Rechner ohne DB und Repo (scripts/icons-bundle.ps1 packt alles): --targets <targets.json>
// mit der Zielliste, die --write-targets hier aus der DB schreibt; die DB-Module werden dann nicht geladen.
import { execFile } from 'node:child_process';
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
  --chunk <n>           Renders je Blender-Prozess (default 50)`;

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
    const { stdout } = await run(bin, ['dcb', 'query', '--p4k', p4k, 'PlayerChoice_PITConfig']);
    writeFileSync(configFile, stdout);
  }
  if (force || !existsSync(groupsDir)) {
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
  for (const d of [out, exportRoot, renderDir]) mkdirSync(d, { recursive: true });

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

  // 1. Export (StarBreaker nutzt selbst alle Kerne, daher nacheinander); fertige Renders nur kopieren
  const started = Date.now();
  const failures: string[] = [];
  const jobs: { target: Target; job: Job }[] = [];
  let exported = 0;
  for (const t of targets) {
    const png = join(renderDir, `${t.entity}.png`);
    if (!args.force && existsSync(png)) {
      for (const uuid of t.uuids) if (!existsSync(join(out, `${uuid}.png`))) copyFileSync(png, join(out, `${uuid}.png`));
      continue;
    }
    let pkg = packageDir(exportRoot, t.entity);
    if (args.force || !pkg) {
      const base = ['entity', 'export', '--p4k', p4k, t.entity, exportRoot, '--kind', 'decomposed'];
      try {
        try {
          await run(starbreaker, t.worn ? [...base, '--worn'] : base);
        } catch (err) {
          if (!t.worn) throw err;
          await run(starbreaker, base); // kein getragenes Modell: das Standardmodell nehmen
        }
        exported++;
        if (exported % 25 === 0) console.log(`  exportiert: ${exported}`);
      } catch (err) {
        failures.push(`${t.entity}: ${(err as Error).message.split('\n').pop()}`);
        continue;
      }
      pkg = packageDir(exportRoot, t.entity);
      if (!pkg) {
        failures.push(`${t.entity}: package directory not found after export`);
        continue;
      }
    }
    jobs.push({ target: t, job: { src: join(pkg, 'scene.blend'), out: png, pose: tables.pose(t.type, t.subType), rig: tables.rig(t.type, t.subType), size } });
  }
  console.log(`Export: ${exported} neu, ${jobs.length} zu rendern, ${failures.length} Fehler (${Math.round((Date.now() - started) / 1000)} s)`);

  // 2. Render in Blöcken, ein Blender-Prozess je Block
  let rendered = 0;
  for (let i = 0; i < jobs.length; i += chunk) {
    const block = jobs.slice(i, i + chunk);
    const jobsFile = join(work, 'jobs.json');
    writeFileSync(jobsFile, JSON.stringify(block.map((b) => b.job)));
    let output = '';
    try {
      const r = await run(blender, ['-b', '--python', renderScript, '--', '--jobs', jobsFile]);
      output = `${r.stdout}\n${r.stderr}`;
    } catch (err) {
      output = (err as Error).message;
    }
    for (const b of block) {
      if (existsSync(b.job.out)) {
        rendered++;
        for (const uuid of b.target.uuids) copyFileSync(b.job.out, join(out, `${uuid}.png`));
      } else {
        const line = output.split('\n').find((l) => l.startsWith('failed: ') && l.includes(b.target.entity));
        failures.push(`${b.target.entity}: ${line ?? 'no render output'}`);
      }
    }
    console.log(`  gerendert: ${rendered}/${jobs.length}`);
  }
  console.log(`Fertig: ${rendered} Renders, ${failures.length} Fehler, ${Math.round((Date.now() - started) / 1000)} s -> ${out}`);
  for (const f of failures) console.log(`  ! ${f}`);
  if (failures.length) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
