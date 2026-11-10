// Raw data pulled from third parties (UEX: community reports, not game data). Kept as received; the
// processing into app data comes later. Nothing outside this schema references it.
import { sql } from 'drizzle-orm';
import { bigint, check, index, jsonb, pgSchema, text, timestamp } from 'drizzle-orm/pg-core';

export const ext = pgSchema('ext');

/**
 * One row per source, endpoint and distinct response: a fetch with the same content as the
 * endpoint's latest row only moves its `checked_at`, so the table holds the history of changes.
 */
export const snapshot = ext.table('snapshot', {
  id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
  // Third party, e.g. 'uex'
  source: text('source').notNull(),
  // The source's resource name, e.g. commodities
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
