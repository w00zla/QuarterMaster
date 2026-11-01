// Privileges as the admin sees them (docs/adminapp.md "Privileges"): the keys with their holders and their
// feature's data, assigning them to users, and the export of a feature's data as ZIP (entries.json plus the
// images) for working off the findings locally. The keys themselves come with migrations.
import { sql } from 'drizzle-orm';
import type { Db } from '../db/client.ts';
import { locText as text, rows } from '../db/query.ts';
import type { PrivilegeDetail, PrivilegeEntry, PrivilegeRow, UserPrivilege } from './api-types.ts';
import { userNames } from './users.ts';
import { zip } from './zip.ts';

const iso = (column: string) => sql.raw(`to_json(${column}) #>> '{}'`);
const UUID_TEXT = sql.raw(`'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'`);

export async function getPrivileges(db: Db): Promise<PrivilegeRow[]> {
  return rows<PrivilegeRow>(db, sql`
    SELECT p.key, p.description, ${iso('p.created_at')} AS "createdAt", ${iso('p.retired_at')} AS "retiredAt",
      (SELECT count(*) FROM app.user_privilege up WHERE up.key = p.key)::int AS "holderCount",
      (SELECT count(*) FROM app.feature_entry e WHERE e.key = p.key)::int AS "entryCount"
    FROM app.privilege p ORDER BY p.retired_at IS NOT NULL, p.key`);
}

/**
 * A feature's rows with the author's name, for a UUID subject the catalog's name, class and type, and the
 * thumbnail's current hash (`thumbs`: the web app's index).
 */
async function entries(db: Db, key: string, lang: string, thumbs: ReadonlyMap<string, string>): Promise<PrivilegeEntry[]> {
  const names = await userNames(db);
  const found = await rows<Omit<PrivilegeEntry, 'userName' | 'thumb'>>(db, sql`
    WITH e AS (SELECT *, CASE WHEN subject ~ ${UUID_TEXT} THEN subject::uuid END AS subject_uuid FROM app.feature_entry WHERE key = ${key})
    SELECT e.id::int AS id, e.user_id AS "userId", e.subject, e.payload, e.blob_type AS "blobType",
      ${iso('e.created_at')} AS "createdAt", ${iso('e.updated_at')} AS "updatedAt",
      coalesce(${text(lang, sql`i.name_key`)}, i.class_name, ${text(lang, sql`r.name_key`)}, r.key) AS "subjectName",
      coalesce(i.class_name, r.key) AS "className", i.type, i.sub_type AS "subType"
    FROM e
    LEFT JOIN catalog.item i ON i.uuid = e.subject_uuid
    LEFT JOIN catalog.resource r ON r.uuid = e.subject_uuid
    ORDER BY e.subject, e.updated_at`);
  return found.map((e) => ({ ...e, userName: names.get(e.userId)?.name ?? null, thumb: thumbs.get(e.subject) ?? null }));
}

export async function getPrivilege(db: Db, key: string, lang: string, thumbs: ReadonlyMap<string, string>): Promise<PrivilegeDetail | null> {
  const [row] = (await getPrivileges(db)).filter((p) => p.key === key);
  if (!row) return null;
  const names = await userNames(db);
  const holders = await rows<Omit<PrivilegeDetail['holders'][number], 'name'>>(db, sql`
    SELECT up.user_id AS "userId", ${iso('up.granted_at')} AS "grantedAt"
    FROM app.user_privilege up WHERE up.key = ${key} ORDER BY up.granted_at`);
  return {
    ...row,
    holders: holders.map((h) => ({ ...h, name: names.get(h.userId)?.name ?? null })),
    entries: await entries(db, key, lang, thumbs),
  };
}

export async function getEntryBlob(db: Db, key: string, id: number): Promise<{ blob: Buffer; blobType: string } | null> {
  const [found] = await rows<{ blob: Buffer | null; blobType: string | null }>(db, sql`
    SELECT blob, blob_type AS "blobType" FROM app.feature_entry WHERE key = ${key} AND id = ${id}`);
  return found?.blob && found.blobType ? { blob: found.blob, blobType: found.blobType } : null;
}

const EXTENSION: Record<string, string> = { 'image/webp': 'webp', 'image/png': 'png' };

/**
 * The export: entries.json (one object per row; `stale` = the thumbnail changed since it was marked) and
 * images/<subject>_<userId>.<ext>.
 */
export async function exportFeature(db: Db, key: string, thumbs: ReadonlyMap<string, string>): Promise<Buffer | null> {
  const detail = await getPrivilege(db, key, 'en', thumbs);
  if (!detail) return null;
  const files = [];
  const list = [];
  for (const e of detail.entries) {
    const blob = e.blobType ? await getEntryBlob(db, key, e.id) : null;
    const image = blob ? `images/${e.subject}_${e.userId}.${EXTENSION[blob.blobType] ?? 'bin'}` : null;
    if (blob && image) files.push({ name: image, data: blob.blob });
    const marked = typeof e.payload.hash === 'string' ? e.payload.hash : null;
    list.push({
      subject: e.subject, name: e.subjectName, className: e.className, type: e.type, subType: e.subType,
      userId: e.userId, userName: e.userName, payload: e.payload, currentThumb: e.thumb,
      stale: marked !== null && e.thumb !== null && marked !== e.thumb, image, createdAt: e.createdAt, updatedAt: e.updatedAt,
    });
  }
  const meta = { key, description: detail.description, exportedAt: new Date().toISOString(), entries: list };
  return zip([{ name: 'entries.json', data: Buffer.from(`${JSON.stringify(meta, null, 2)}\n`) }, ...files]);
}

/** Every key not retired plus the retired ones the user holds, with the user's assignment. */
export async function getUserPrivileges(db: Db, userId: string): Promise<UserPrivilege[]> {
  return rows<UserPrivilege>(db, sql`
    SELECT p.key, p.description, p.retired_at IS NOT NULL AS retired,
      ${iso('up.granted_at')} AS "grantedAt"
    FROM app.privilege p LEFT JOIN app.user_privilege up ON up.key = p.key AND up.user_id = ${userId}
    WHERE p.retired_at IS NULL OR up.user_id IS NOT NULL ORDER BY p.key`);
}

/** Assigns a key (again: nothing changes); false = no such key or it is retired. */
export async function grantPrivilege(db: Db, userId: string, key: string): Promise<boolean> {
  const [found] = await rows<{ key: string }>(db, sql`SELECT key FROM app.privilege WHERE key = ${key} AND retired_at IS NULL`);
  if (!found) return false;
  await db.execute(sql`INSERT INTO app.user_privilege (user_id, key) VALUES (${userId}, ${key}) ON CONFLICT (user_id, key) DO NOTHING`);
  return true;
}

/** Takes a key back; the user's feature data stays. */
export async function revokePrivilege(db: Db, userId: string, key: string): Promise<void> {
  await db.execute(sql`DELETE FROM app.user_privilege WHERE user_id = ${userId} AND key = ${key}`);
}
