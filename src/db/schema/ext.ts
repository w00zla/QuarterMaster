// Raw data pulled from third parties (UEX: community reports, not game data). Kept as received; the
// processing into app data comes later. Nothing outside this schema references it.
import { sql } from 'drizzle-orm';
import { bigint, check, index, integer, jsonb, numeric, pgSchema, text, timestamp } from 'drizzle-orm/pg-core';

export const ext = pgSchema('ext');

/**
 * One row per source, endpoint and distinct response: a fetch with the same content as the
 * endpoint's latest row only moves its `checked_at`, so the table holds the history of changes.
 */
export const snapshot = ext.table('snapshot', {
  id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
  // Third party, e.g. 'uex'
  source: text('source').notNull(),
  // The source's resource name, e.g. refineries_yields
  endpoint: text('endpoint').notNull(),
  // Hex SHA-256 of `data` as received (JSON text)
  contentHash: text('content_hash').notNull(),
  // The response's payload (UEX: its `data` array)
  data: jsonb('data').notNull(),
  // First fetch with this content
  fetchedAt: timestamp('fetched_at', { withTimezone: true }).notNull().defaultNow(),
  // Latest fetch that returned this content
  checkedAt: timestamp('checked_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  check('snapshot_content_hash_format', sql`${t.contentHash} ~ '^[0-9a-f]{64}$'`),
  index().on(t.source, t.endpoint, t.id),
]);

/**
 * Refining methods with community values (no source has the game's own numbers: they are computed
 * server-side). Seeded and corrected by migrations; the app uses them as estimates only.
 */
export const refiningMethod = ext.table('refining_method', {
  // UEX's method code: DIN, FRX, PYR, EST, TND, GAS, COR, KZW, XCR
  code: text('code').primaryKey(),
  // The game's name, a catalog localization key (refinery_ui_processingtype_slowcareful)
  nameKey: text('name_key').notNull(),
  // Base yield in % of the ore
  yieldPct: numeric('yield_pct', { precision: 5, scale: 2 }).notNull(),
  // Processing time per SCU of ore
  secondsPerScu: integer('seconds_per_scu').notNull(),
  // Where the values come from and for which game version
  source: text('source').notNull(),
  gameVersion: text('game_version').notNull(),
}, (t) => [
  check('refining_method_code_format', sql`${t.code} ~ '^[A-Z]{3}$'`),
  check('refining_method_yield', sql`${t.yieldPct} > 0 AND ${t.yieldPct} <= 100`),
  check('refining_method_seconds', sql`${t.secondsPerScu} > 0`),
]);
