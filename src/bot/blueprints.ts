// Blueprint catalog for the bot (labels, search) and the per-user blueprint registry.
// The catalog is held in memory per language (1.6k rows, see importCache) so autocomplete stays fast.
import { and, eq, sql } from 'drizzle-orm';
import type { Db } from '../db/client.ts';
import { importCache } from '../db/import-cache.ts';
import { categoryText, itemClassText, locText, rows, withCategoryLabel } from '../db/query.ts';
import { appUser, member, userBlueprint } from '../db/schema/app.ts';
import type { Lang } from './i18n.ts';
import { recordHistory, type Source } from '../history/record.ts';

export interface BlueprintEntry {
  uuid: string;
  key: string;
  // In the language, else English, else the technical name
  name: string;
  nameEn: string;
  size: number | null;
  gradeLetter: string | null;
  itemClass: string | null;
  manufacturerCode: string | null;
  isDefault: boolean;
  retired: boolean;
  categoryLabel: string | null;
  // Display label, unique within the catalog (see buildLabels)
  label: string;
}

// Discord limit for choice names
const MAX_LABEL = 100;

/** "Name · S3 · B Industrial · CHCO"; labels that still collide get the tokens of the blueprint key that tell them apart. */
export function buildLabels(entries: Omit<BlueprintEntry, 'label'>[]): BlueprintEntry[] {
  const base = entries.map((e) => [
    e.name,
    e.size !== null ? `S${e.size}` : null,
    [e.gradeLetter, e.itemClass].filter(Boolean).join(' ') || null,
    e.manufacturerCode,
  ].filter(Boolean).join(' · '));
  const groups = new Map<string, number[]>();
  base.forEach((label, i) => groups.set(label, [...(groups.get(label) ?? []), i]));
  const labels = [...base];
  for (const [label, idx] of groups) {
    if (idx.length < 2) continue;
    const tokens = idx.map((i) => entries[i]!.key.split('_').filter((t) => !/^(bp|craft)$/i.test(t)));
    const common = tokens.reduce((acc, t) => acc.filter((x) => t.includes(x)));
    idx.forEach((i, n) => {
      const suffix = tokens[n]!.filter((t) => !common.includes(t)).join(' ') || entries[i]!.key;
      labels[i] = `${label} · ${suffix}`;
    });
  }
  return entries.map((e, i) => ({ ...e, label: truncate(labels[i]!) }));
}

const truncate = (s: string) => (s.length > MAX_LABEL ? `${s.slice(0, MAX_LABEL - 1)}…` : s);

export interface BlueprintCatalog {
  entries: BlueprintEntry[];
  byUuid: Map<string, BlueprintEntry>;
}

export const blueprintCatalog = importCache(async (db: Db, lang: Lang): Promise<BlueprintCatalog> => {
  const loaded = await rows<Omit<BlueprintEntry, 'label'> & { category: string | null }>(db, sql`
    SELECT b.uuid, b.key,
      coalesce(${locText(lang, sql`i.name_key`)}, i.class_name, b.key) AS name,
      coalesce(${locText('en', sql`i.name_key`)}, i.class_name, b.key) AS "nameEn",
      i.size, i.grade_letter AS "gradeLetter", ${itemClassText(lang, 'i')} AS "itemClass", m.code AS "manufacturerCode",
      b.is_default AS "isDefault", b.retired_at IS NOT NULL AS retired, c.key AS category, ${categoryText(lang)} AS "categoryLabel"
    FROM catalog.blueprint b
    LEFT JOIN catalog.item i ON i.uuid = b.output_item_uuid
    LEFT JOIN catalog.manufacturer m ON m.uuid = i.manufacturer_uuid
    LEFT JOIN catalog.blueprint_category c ON c.uuid = b.category_uuid`);
  const entries = buildLabels(loaded.map((r) => {
    const { category: _c, categoryGroup: _g, ...rest } = withCategoryLabel(r);
    return rest;
  }));
  return { entries, byUuid: new Map(entries.map((e) => [e.uuid, e])) };
});

/**
 * Up to `limit` entries matching every word of the query in the label or the English name;
 * names starting with the first word come first, then alphabetical.
 */
export function searchBlueprints(entries: BlueprintEntry[], query: string, limit = 25): BlueprintEntry[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const scored: [number, BlueprintEntry][] = [];
  for (const e of entries) {
    const hay = `${e.label} ${e.nameEn}`.toLowerCase();
    if (!words.every((w) => hay.includes(w))) continue;
    const first = words[0];
    const starts = !first || e.name.toLowerCase().startsWith(first) || e.nameEn.toLowerCase().startsWith(first);
    scored.push([starts ? 0 : 1, e]);
  }
  return scored.sort((a, b) => a[0] - b[0] || a[1].label.localeCompare(b[1].label)).slice(0, limit).map(([, e]) => e);
}

export async function ownedBlueprints(db: Db, userId: string): Promise<Set<string>> {
  const owned = await db.select({ uuid: userBlueprint.blueprintUuid }).from(userBlueprint).where(eq(userBlueprint.userId, userId));
  return new Set(owned.map((r) => r.uuid));
}

const blueprintHistory = (source: Source, action: 'add' | 'remove', userId: string, blueprintUuid: string) => ({
  source, category: 'blueprint' as const, action, actorUserId: userId, ownerUserId: userId, targetKind: 'blueprint' as const, targetUuid: blueprintUuid,
});

/** true if added, false if it was registered already (no history row then). */
export async function addBlueprint(db: Db, userId: string, blueprintUuid: string, source: Source): Promise<boolean> {
  return db.transaction(async (tx) => {
    // The roster cleanup may have removed the user row (no data left), e.g. under a web session
    await tx.insert(appUser).values({ userId }).onConflictDoNothing();
    const added = await tx.insert(userBlueprint).values({ userId, blueprintUuid }).onConflictDoNothing().returning();
    if (added.length) await recordHistory(tx, blueprintHistory(source, 'add', userId, blueprintUuid));
    return added.length > 0;
  });
}

/** true if removed, false if it was not registered (no history row then). */
export async function removeBlueprint(db: Db, userId: string, blueprintUuid: string, source: Source): Promise<boolean> {
  return db.transaction(async (tx) => {
    const removed = await tx.delete(userBlueprint)
      .where(and(eq(userBlueprint.userId, userId), eq(userBlueprint.blueprintUuid, blueprintUuid))).returning();
    if (removed.length) await recordHistory(tx, blueprintHistory(source, 'remove', userId, blueprintUuid));
    return removed.length > 0;
  });
}

/** Display names of the org's active members who registered the blueprint, alphabetical. */
export async function whoHas(db: Db, guildId: string, blueprintUuid: string): Promise<string[]> {
  const found = await db.select({ name: member.displayName }).from(member)
    .innerJoin(userBlueprint, eq(userBlueprint.userId, member.userId))
    .where(and(eq(member.guildId, guildId), eq(member.active, true), eq(userBlueprint.blueprintUuid, blueprintUuid)));
  return found.map((r) => r.name).sort((a, b) => a.localeCompare(b));
}

/** The org member's display name and whether they are active; null if they are not in the roster. */
export async function rosterEntry(db: Db, guildId: string, userId: string) {
  const [row] = await db.select({ displayName: member.displayName, active: member.active }).from(member)
    .where(and(eq(member.guildId, guildId), eq(member.userId, userId)));
  return row ?? null;
}
