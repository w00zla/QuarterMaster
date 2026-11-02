// Schreibt die Zielliste fürs Icon-Rendern (tools/packshot): alle Gear-Items der App (Schiffskomponenten +
// FPS-Ausrüstung, dieselbe Regel wie der Stock-Service), die Sammelobjekte, die Shop-Items und die Rohstoffe mit
// Thumbnail-Entity (roh und raffiniert teilen sich den Brocken), gruppiert nach Entity. Gerendert wird mit
// `pnpm packshot`, das targets.json im packshot-Ordner liest und die DB nicht braucht.
// Usage: pnpm packshot:targets [--out <targets.json>]
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';

const HELP = `Usage: pnpm packshot:targets [--out <file>]
  --out <file>   Zielliste aus der DB schreiben (default: local/packshot/targets.json, der packshot-Ordner im Repo)`;

// names: Klarname je UUID (gleiche Reihenfolge) für die Dateinamen der Icons
interface Target { uuids: string[]; names?: string[]; entity: string; type: string; subType: string; worn: boolean }

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

async function main() {
  const { values: args } = parseArgs({
    options: {
      out: { type: 'string', default: 'local/packshot/targets.json' },
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
