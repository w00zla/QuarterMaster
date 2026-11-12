// Small helpers for raw SQL reads against the catalog.
import { sql, type SQL } from 'drizzle-orm';
import type { Db } from './client.ts';
import {
  BLUEPRINT_CATEGORY_GROUP_SQL, BLUEPRINT_CATEGORY_KEY_PREFIX, blueprintCategoryGroup, itemClassKeySql, labelFromKey,
} from '../catalog/labels.ts';

/** Localized text for a loc key column: the language, then English. */
export const locText = (lang: string, key: SQL) => sql`coalesce(
  (SELECT e.value FROM catalog.localization_effective e WHERE e.lang = ${lang} AND e.key = ${key}),
  (SELECT e.value FROM catalog.localization_effective e WHERE e.lang = 'en' AND e.key = ${key}))`;

/** Name of the category group of the blueprint category joined as `c` (app text). */
export const categoryText = (lang: string) =>
  locText(lang, sql`${BLUEPRINT_CATEGORY_KEY_PREFIX} || lower(${sql.raw(BLUEPRINT_CATEGORY_GROUP_SQL)})`);

/** Fills the category group and its derived name where no app text exists. */
export function withCategoryLabel<T extends { category: string | null; categoryLabel: string | null }>(row: T): T & { categoryGroup: string | null } {
  const group = row.category ? blueprintCategoryGroup(row.category) : null;
  return { ...row, categoryGroup: group, categoryLabel: row.categoryLabel ?? (group ? labelFromKey(group) : null) };
}

/** Display name of the item's class (`alias` = the joined item): app text, else the English class. */
export const itemClassText = (lang: string, alias: string) => sql`coalesce(
  ${locText(lang, sql.raw(itemClassKeySql(`${alias}.item_class`)))}, ${sql.raw(alias)}.item_class)`;

export async function rows<T>(db: Db, query: SQL): Promise<T[]> {
  return (await db.execute(query)) as unknown as T[];
}

export async function one<T>(db: Db, query: SQL): Promise<T | null> {
  return (await rows<T>(db, query))[0] ?? null;
}
