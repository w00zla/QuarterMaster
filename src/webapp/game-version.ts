// The game version of the installed catalog (the latest import's label and build), for GET /api/capabilities: public
// and unauthenticated, so the query is cached and shared by concurrent requests.
import { sql } from 'drizzle-orm';
import type { Db } from '../db/client.ts';
import { one } from '../db/query.ts';
import type { Capabilities } from './api-types.ts';

const TTL_MS = 5_000;

export type GameVersion = Capabilities['game'];

/**
 * A reader of the latest import's game version, null while no catalog is installed. The answer is kept for a few seconds
 * (so a data pack install shows without a restart); a failing query answers the last value, or null.
 */
export function gameVersionReader(db: Db): () => Promise<GameVersion> {
  let value: GameVersion = null;
  let at = Number.NEGATIVE_INFINITY;
  let loading: Promise<GameVersion> | null = null;
  const load = async (): Promise<GameVersion> => {
    try {
      const row = await one<{ label: string | null; build: number }>(db, sql`
        SELECT game_label AS label, game_build AS build FROM catalog.import ORDER BY id DESC LIMIT 1`);
      value = row ? { label: row.label, build: row.build } : null;
    } catch (err) {
      console.error('game version: cannot read it', err);
    }
    at = Date.now();
    return value;
  };
  return async () => {
    if (Date.now() - at < TTL_MS) return value;
    loading ??= load().finally(() => { loading = null; });
    return loading;
  };
}
