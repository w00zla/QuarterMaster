// Loads planner recipes from the catalog (server side; the web API and the bot use it).
import { sql } from 'drizzle-orm';
import type { Db } from '../db/client.ts';
import { categoryText, itemClassText, locText, one, rows, withCategoryLabel } from '../db/query.ts';
import { ITEM_SUBTYPE_KEY_PREFIX, ITEM_TYPE_KEY_PREFIX, typeLabel } from '../catalog/labels.ts';
import type { ModifierRange, PlannerData, PlannerInput, PlannerRecipe, PlannerSlot } from './types.ts';

// Used when the game data has no default (it is 500 as of 4.10)
const FALLBACK_DEFAULT_QUALITY = 500;

/** Recipes of the given blueprints (first tier) with names in the language. Unknown UUIDs are skipped. */
export async function loadPlannerData(db: Db, uuids: string[], lang: string): Promise<PlannerData> {
  const params = await one<{ q: number | null }>(db, sql`
    SELECT (data->>'defaultCompositionQuality')::int AS q FROM catalog.raw_record WHERE type = 'CraftingGlobalParams' LIMIT 1`);
  const defaultQuality = params?.q ?? FALLBACK_DEFAULT_QUALITY;
  if (uuids.length === 0) return { defaultQuality, recipes: [] };
  const ids = sql.join(uuids.map((u) => sql`${u}::uuid`), sql`, `);

  const blueprints = await rows<Omit<PlannerRecipe, 'slots'> & { outputSubType: string | null }>(db, sql`
    SELECT b.uuid, b.key, coalesce(${locText(lang, sql`i.name_key`)}, i.class_name, b.key) AS name, i.type AS "outputType",
      ${locText(lang, sql`${ITEM_TYPE_KEY_PREFIX} || lower(i.type)`)} AS "outputTypeLabel",
      i.sub_type AS "outputSubType", ${locText(lang, sql`${ITEM_SUBTYPE_KEY_PREFIX} || lower(i.sub_type)`)} AS "outputSubTypeLabel",
      i.size, i.grade, i.grade_letter AS "gradeLetter", ${itemClassText(lang, 'i')} AS "itemClass",
      coalesce(${locText(lang, sql`m.name_key`)}, m.code) AS manufacturer, b.is_default AS "isDefault",
      c.key AS category, ${categoryText(lang)} AS "categoryLabel",
      coalesce(t.craft_seconds, 0)::float8 AS "craftSeconds", coalesce(t.required_slots, 0) AS "requiredSlots",
      b.retired_at IS NOT NULL AS retired
    FROM catalog.blueprint b
    LEFT JOIN catalog.item i ON i.uuid = b.output_item_uuid
    LEFT JOIN catalog.manufacturer m ON m.uuid = i.manufacturer_uuid
    LEFT JOIN catalog.blueprint_category c ON c.uuid = b.category_uuid
    LEFT JOIN catalog.blueprint_tier t ON t.blueprint_uuid = b.uuid AND t.tier_index = 0
    WHERE b.uuid IN (${ids})`);
  const slots = await rows<Omit<PlannerSlot, 'inputs' | 'modifiers'> & { blueprintUuid: string; modifiers: { propertyUuid: string; ranges: ModifierRange[] }[] }>(db, sql`
    SELECT s.blueprint_uuid AS "blueprintUuid", s.slot_index AS index, s.key,
      coalesce(${locText(lang, sql`s.name_key`)}, initcap(s.key)) AS name, s.required_count AS "requiredCount", s.modifiers
    FROM catalog.blueprint_slot s WHERE s.tier_index = 0 AND s.blueprint_uuid IN (${ids}) ORDER BY s.slot_index`);
  const inputs = await rows<PlannerInput & { blueprintUuid: string; slotIndex: number }>(db, sql`
    SELECT bi.blueprint_uuid AS "blueprintUuid", bi.slot_index AS "slotIndex", bi.kind, coalesce(bi.resource_uuid, bi.item_uuid) AS uuid,
      coalesce(r.key, i.class_name) AS key, coalesce(${locText(lang, sql`coalesce(r.name_key, i.name_key)`)}, r.key, i.class_name) AS name,
      bi.quantity::text AS quantity, bi.min_quality AS "minQuality"
    FROM catalog.blueprint_input bi
    LEFT JOIN catalog.resource r ON r.uuid = bi.resource_uuid
    LEFT JOIN catalog.item i ON i.uuid = bi.item_uuid
    WHERE bi.tier_index = 0 AND bi.blueprint_uuid IN (${ids}) ORDER BY bi.slot_index, bi.input_index`);
  const properties = new Map((await rows<{ uuid: string; key: string; name: string; unit: string | null }>(db, sql`
    SELECT uuid, key, coalesce(${locText(lang, sql`name_key`)}, key) AS name, ${locText(lang, sql`unit_key`)} AS unit
    FROM catalog.crafted_property`)).map((p) => [p.uuid, p]));

  const recipes = blueprints.map(({ outputSubType, ...b }) => ({
    ...withCategoryLabel(b),
    outputTypeLabel: typeLabel(b.outputType, b.outputTypeLabel),
    outputSubTypeLabel: typeLabel(outputSubType, b.outputSubTypeLabel),
    slots: slots.filter((s) => s.blueprintUuid === b.uuid).map(({ blueprintUuid: _b, modifiers, ...s }) => ({
      ...s,
      inputs: inputs.filter((i) => i.blueprintUuid === b.uuid && i.slotIndex === s.index)
        .map(({ blueprintUuid: _bu, slotIndex: _si, ...i }) => i),
      modifiers: modifiers.map((m) => {
        const p = properties.get(m.propertyUuid);
        return { propertyUuid: m.propertyUuid, key: p?.key ?? m.propertyUuid, name: p?.name ?? m.propertyUuid, unit: p?.unit ?? null, ranges: m.ranges };
      }),
    })),
  }));
  return { defaultQuality, recipes };
}
