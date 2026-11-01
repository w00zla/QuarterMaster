// Privileges and their features' data (docs/webapp.md "Privileges"): a privilege key (app.privilege) unlocks a
// feature for the users the admin assigned it to (app.user_privilege). Such a feature keeps its data in
// app.feature_entry, one row per user and subject with a JSON payload and optionally one image. Every holder of
// the key sees every row, only the row's user changes it. The DB grants cover every key: the check lives here,
// read on every request (rights are never cached). Registered by registerRoutes.
import { sql } from 'drizzle-orm';
import type { Context, Hono } from 'hono';
import { z } from 'zod';
import type { Db } from '../db/client.ts';
import { itemClassText, locText, rows } from '../db/query.ts';
import type { FeatureEntriesResponse, FeatureEntry, Lang, OkResponse, ThumbReviewSubjectsResponse } from './api-types.ts';
import { HttpError, type Env } from './routes.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const KEY = /^[a-z][a-z0-9-]{1,40}$/;
// One image per row (a cut-out of a screenshot): the bytes, base64 in the JSON body
export const MAX_BLOB_BYTES = 512 * 1024;
export const BLOB_BODY_LIMIT = Math.ceil(MAX_BLOB_BYTES / 3) * 4 + 1024;
// The upload's path (app.ts gives it a larger body limit than the rest of the API)
export const BLOB_ROUTE = /^\/api\/features\/[a-z0-9-]+\/entries\/[^/]+\/blob$/;

const IMAGE_TYPES = ['image/webp', 'image/png'] as const;
type ImageType = typeof IMAGE_TYPES[number];
const isImage: Record<ImageType, (b: Buffer) => boolean> = {
  'image/png': (b) => b.length > 8 && b.readUInt32BE(0) === 0x89504e47,
  'image/webp': (b) => b.length > 12 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP',
};

/** What a feature accepts: the subject's format, the payload's schema, the image types (none = no image). */
interface FeatureDef {
  subject: RegExp;
  payload: z.ZodType<Record<string, unknown>>;
  images: readonly ImageType[];
}

// Each key here comes with the migration that inserts it into app.privilege
export const FEATURES: Record<string, FeatureDef> = {
  // A thumbnail marked as wrong: the subject is the catalog UUID, hash the thumbnail it was marked on
  // (a re-render brings a new hash), the image the reference the user cut out of a screenshot
  'thumb-review': { subject: UUID, payload: z.object({ hash: z.string().regex(/^[0-9a-f]{8}$/) }).strict(), images: IMAGE_TYPES },
};

/** The user's privileges in force: assigned, not expired, the key not retired. */
export async function privilegesOf(db: Db, userId: string): Promise<string[]> {
  const found = await rows<{ key: string }>(db, sql`
    SELECT up.key FROM app.user_privilege up JOIN app.privilege p ON p.key = up.key
    WHERE up.user_id = ${userId} AND p.retired_at IS NULL AND (up.expires_at IS NULL OR up.expires_at > now())
    ORDER BY up.key`);
  return found.map((r) => r.key);
}

/** Who holds a privilege in force (realtime: who gets a feature's changes). */
export async function holdersOf(db: Db, key: string): Promise<Set<string>> {
  const found = await rows<{ userId: string }>(db, sql`
    SELECT up.user_id AS "userId" FROM app.user_privilege up JOIN app.privilege p ON p.key = up.key
    WHERE up.key = ${key} AND p.retired_at IS NULL AND (up.expires_at IS NULL OR up.expires_at > now())`);
  return new Set(found.map((r) => r.userId));
}

async function jsonBody(c: Context): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    throw new HttpError(400, 'invalid');
  }
}

/** The feature of the path, after checking the caller holds its key. */
async function feature(c: Context<Env>, db: Db): Promise<{ key: string; def: FeatureDef }> {
  const key = c.req.param('key') ?? '';
  const def = KEY.test(key) && Object.hasOwn(FEATURES, key) ? FEATURES[key]! : null;
  if (!def) throw new HttpError(404, 'notFound');
  if (!(await privilegesOf(db, c.get('session').userId)).includes(key)) throw new HttpError(403, 'noPrivilege');
  return { key, def };
}

function subjectOf(c: Context, def: FeatureDef): string {
  const subject = c.req.param('subject') ?? '';
  if (!def.subject.test(subject)) throw new HttpError(400, 'invalid');
  return subject;
}

/** Every row of a feature, newest first, with the author's name (newest web session, the token's profile, the roster). */
export async function featureEntries(db: Db, key: string, viewer: string): Promise<FeatureEntry[]> {
  const found = await rows<Omit<FeatureEntry, 'own'>>(db, sql`
    SELECT e.id::int AS id, e.user_id AS "userId", e.subject, e.payload, e.blob_type AS "blobType",
      to_json(e.created_at) #>> '{}' AS "createdAt", to_json(e.updated_at) #>> '{}' AS "updatedAt",
      coalesce(
        (SELECT coalesce(s.discord_global_name, s.discord_username) FROM web.session s WHERE s.user_id = e.user_id ORDER BY s.last_seen_at DESC LIMIT 1),
        (SELECT coalesce(t.discord_global_name, t.discord_username) FROM web.api_token t WHERE t.user_id = e.user_id),
        (SELECT m.display_name FROM app.member m WHERE m.user_id = e.user_id ORDER BY m.active DESC, m.updated_at DESC LIMIT 1)
      ) AS "userName"
    FROM app.feature_entry e WHERE e.key = ${key} ORDER BY e.updated_at DESC, e.id DESC`);
  return found.map((e) => ({ ...e, own: e.userId === viewer }));
}

const putSchema = z.object({ payload: z.unknown() }).strict();
const blobSchema = z.object({ type: z.enum(IMAGE_TYPES), data: z.string().max(BLOB_BODY_LIMIT) }).strict();

export function registerFeatureRoutes(api: Hono<Env>, db: Db, thumbs: () => ReadonlyMap<string, string>) {
  api.get('/features/:key/entries', async (c) => {
    const { key } = await feature(c, db);
    return c.json({ entries: await featureEntries(db, key, c.get('session').userId) } satisfies FeatureEntriesResponse);
  });

  // Creates or replaces the own row for the subject (its image stays)
  api.put('/features/:key/entries/:subject', async (c) => {
    const { key, def } = await feature(c, db);
    const subject = subjectOf(c, def);
    const parsed = putSchema.safeParse(await jsonBody(c));
    const payload = parsed.success ? def.payload.safeParse(parsed.data.payload) : null;
    if (!payload?.success) throw new HttpError(400, 'invalid');
    await db.execute(sql`
      INSERT INTO app.feature_entry (key, user_id, subject, payload) VALUES (${key}, ${c.get('session').userId}, ${subject}, ${JSON.stringify(payload.data)}::jsonb)
      ON CONFLICT (key, user_id, subject) DO UPDATE SET payload = excluded.payload, updated_at = now()`);
    return c.json({ ok: true } satisfies OkResponse);
  });

  api.delete('/features/:key/entries/:subject', async (c) => {
    const { key, def } = await feature(c, db);
    const subject = subjectOf(c, def);
    await db.execute(sql`DELETE FROM app.feature_entry WHERE key = ${key} AND user_id = ${c.get('session').userId} AND subject = ${subject}`);
    return c.json({ ok: true } satisfies OkResponse);
  });

  // The own row's image: base64 in JSON (writes take JSON only), checked against its type's signature
  api.put('/features/:key/entries/:subject/blob', async (c) => {
    const { key, def } = await feature(c, db);
    const subject = subjectOf(c, def);
    const parsed = blobSchema.safeParse(await jsonBody(c));
    if (!parsed.success || !def.images.includes(parsed.data.type)) throw new HttpError(400, 'invalid');
    const bytes = Buffer.from(parsed.data.data, 'base64');
    if (bytes.length > MAX_BLOB_BYTES || !isImage[parsed.data.type](bytes)) throw new HttpError(400, 'invalid');
    const updated = await rows<{ id: number }>(db, sql`
      UPDATE app.feature_entry SET blob = ${bytes}, blob_type = ${parsed.data.type}, updated_at = now()
      WHERE key = ${key} AND user_id = ${c.get('session').userId} AND subject = ${subject} RETURNING id`);
    if (!updated.length) throw new HttpError(404, 'notFound');
    return c.json({ ok: true } satisfies OkResponse);
  });

  // Any row's image (every holder sees every row); the URL carries the row's updated_at
  api.get('/features/:key/blob/:id', async (c) => {
    const { key } = await feature(c, db);
    const id = Number(c.req.param('id'));
    if (!Number.isSafeInteger(id) || id < 1) throw new HttpError(400, 'invalid');
    const [found] = await rows<{ blob: Buffer | null; blobType: string | null }>(db, sql`
      SELECT blob, blob_type AS "blobType" FROM app.feature_entry WHERE key = ${key} AND id = ${id}`);
    if (!found?.blob || !found.blobType) throw new HttpError(404, 'notFound');
    c.header('Content-Type', found.blobType);
    c.header('Cache-Control', 'private, max-age=86400');
    return c.body(new Uint8Array(found.blob));
  });

  // thumb-review: every thumbnail with its name and type, grouped in the SPA
  api.get('/features/thumb-review/subjects', async (c) => {
    if (!(await privilegesOf(db, c.get('session').userId)).includes('thumb-review')) throw new HttpError(403, 'noPrivilege');
    const lang: Lang = c.req.query('lang') === 'de' ? 'de' : 'en';
    const index = thumbs();
    const found = await rows<{ uuid: string; name: string; className: string; type: string | null; subType: string | null; typeLabel: string | null }>(db, sql`
      SELECT i.uuid::text, coalesce(${locText(lang, sql`i.name_key`)}, i.class_name) AS name, i.class_name AS "className",
        i.type, i.sub_type AS "subType", ${itemClassText(lang, 'i')} AS "typeLabel"
      FROM catalog.item i WHERE i.retired_at IS NULL
      UNION ALL
      SELECT r.uuid::text, coalesce(${locText(lang, sql`r.name_key`)}, r.key), r.key, NULL, NULL, NULL
      FROM catalog.resource r WHERE r.retired_at IS NULL`);
    const subjects = found.flatMap((s) => {
      const hash = index.get(s.uuid);
      return hash ? [{ ...s, hash }] : [];
    });
    return c.json({ subjects } satisfies ThumbReviewSubjectsResponse);
  });
}
