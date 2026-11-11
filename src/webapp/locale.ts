// GET /api/companion/locale: the game's own English texts as the lines of a global.ini, for the companion's
// text lookup (docs/webapp.md "Companion"). Only the `game` source in `en`, never the effective texts: the
// singleuser variant's language pack and external sources sit above the game's texts there, and the companion
// reads the player's pack itself.
import { gzipSync } from 'node:zlib';
import { and, asc, eq } from 'drizzle-orm';
import type { Hono } from 'hono';
import type { Db } from '../db/client.ts';
import * as c from '../db/schema/catalog.ts';
import { GAME_SOURCE } from '../catalog/import/localization.ts';
import type { Env } from './routes.ts';

const LANG = 'en';

/** The `key=value` lines of a global.ini: a line break inside a value is written as the literal `\n`, as the game does. */
export function iniText(texts: Iterable<{ key: string; value: string }>): string {
  let out = '';
  for (const { key, value } of texts) out += `${key}=${value.replace(/\r?\n/g, '\\n')}\n`;
  return out;
}

/** Whether an If-None-Match header names `tag` (or `*`). */
function matches(header: string | undefined, tag: string): boolean {
  return header !== undefined && header.split(',').some((t) => t.trim() === '*' || t.trim().replace(/^W\//, '') === tag);
}

export function registerCompanionLocale(api: Hono<Env>, db: Db) {
  const source = async () => (await db.select({ sha: c.localizationSource.contentSha256 }).from(c.localizationSource)
    .where(and(eq(c.localizationSource.source, GAME_SOURCE), eq(c.localizationSource.lang, LANG))))[0]?.sha ?? null;

  // The body is kept until a catalog import changed the game's English texts (their content hash is the ETag), gzipped on demand
  let kept: { sha: string; body: Buffer; zipped?: Buffer } | null = null;
  const load = async (sha: string) => {
    if (kept?.sha === sha) return kept;
    const rows = await db.select({ key: c.localization.key, value: c.localization.value }).from(c.localization)
      .where(and(eq(c.localization.source, GAME_SOURCE), eq(c.localization.lang, LANG))).orderBy(asc(c.localization.key));
    // An import between the two reads: the texts belong to a newer hash than the one asked for
    return (kept = { sha: (await source()) ?? sha, body: Buffer.from(iniText(rows), 'utf8') });
  };

  api.get('/companion/locale', async (ctx) => {
    const sha = await source();
    if (!sha) return ctx.json({ error: 'noCatalog' }, 404);
    const entry = await load(sha);
    const zip = /\bgzip\b/i.test(ctx.req.header('Accept-Encoding') ?? '');
    const tag = `"${entry.sha}${zip ? '-gzip' : ''}"`;
    ctx.header('ETag', tag);
    ctx.header('Cache-Control', 'private, no-cache');
    ctx.header('Vary', 'Accept-Encoding');
    if (matches(ctx.req.header('If-None-Match'), tag)) return ctx.body(null, 304);
    ctx.header('Content-Type', 'text/plain; charset=utf-8');
    if (!zip) return ctx.body(new Uint8Array(entry.body));
    ctx.header('Content-Encoding', 'gzip');
    return ctx.body(new Uint8Array((entry.zipped ??= gzipSync(entry.body))));
  });
}
