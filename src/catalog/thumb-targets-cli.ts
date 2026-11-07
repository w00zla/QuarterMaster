// Writes the target list for packshot (the icon renderer): the thumbnail targets of thumb-targets.ts
// (gear, harvestables, shop items, resources with a thumbnail entity; raw and refined share the chunk), grouped by entity.
// Default output: local/packshot-targets.json (gitignored); copy it into packshot's targets/ folder by hand. packshot does not need the DB.
// Usage: pnpm packshot:targets [--out <targets.json>]
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';

const HELP = `Usage: pnpm packshot:targets [--out <file>]
  --out <file>   Write the target list from the DB (default: local/packshot-targets.json; copy it into packshot's targets/ folder by hand)`;

// names: the display name per UUID (same order) for the icons' file names
interface Target { uuids: string[]; names?: string[]; entity: string; type: string; subType: string; worn: boolean }

/** The items and resources the app shows, grouped by entity (resources share chunks). */
async function loadTargets(): Promise<Target[]> {
  const [{ connect }, { thumbTargets }] = await Promise.all([import('../db/client.ts'), import('./thumb-targets.ts')]);
  const { db, close } = connect(process.env.DATABASE_URL);
  try {
    const { items, resources } = await thumbTargets(db, 'en');
    const byEntity = new Map<string, Target>();
    for (const i of items) {
      // armour and clothing worn, not as the loot crate
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

async function main() {
  const { values: args } = parseArgs({
    options: {
      out: { type: 'string', default: 'local/packshot-targets.json' },
      help: { type: 'boolean', default: false },
    },
  });
  if (args.help) {
    console.log(HELP);
    return;
  }
  const targets = await loadTargets();
  const file = resolve(args.out);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(targets, null, 1));
  console.log(`${targets.length} Entities -> ${file}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
