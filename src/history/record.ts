// Write side of a user's history (app.history): one row per stock, refinery or blueprint action,
// written in the same transaction as the change by the code that makes it (stock service,
// blueprint registry). Where the action came from is part of every row.
import { sql } from 'drizzle-orm';
import type { Tx } from '../db/client.ts';

export type Source = 'bot' | 'webapp' | 'companion';
export type HistoryCategory = 'stock' | 'refinery' | 'blueprint';
export type HistoryTargetKind = 'resource' | 'item' | 'blueprint';

/** What a history row keeps besides who/what (catalog UUIDs and NUMERIC text, as the action had them). */
export interface HistoryDetails {
  amount?: string;
  quality?: number;
  locationUuid?: string;
  designation?: 'personal' | 'org';
  // Move: where it went
  toLocationUuid?: string;
  toDesignation?: 'personal' | 'org';
  // Adjust: the quantity before
  from?: string;
  // Add, remove: what the batch holds afterwards (an add may land in a batch with some already; "0": emptied)
  batchAmount?: string;
  // Stock: the orgs the batch was shared in when it changed (an org's logs channel shows these rows)
  sharedIn?: string[];
  // Refinery start
  durationSeconds?: number | null;
  expectedYield?: string | null;
  // Refinery start and done: the work order
  jobId?: string;
  // Refinery done: the ore that went in
  oreUuid?: string;
  oreAmount?: string;
  oreQuality?: number;
}

export interface HistoryRecord {
  source: Source;
  category: HistoryCategory;
  action: string;
  actorUserId: string;
  ownerUserId: string;
  toOwnerUserId?: string | null;
  guildId?: string | null;
  targetKind: HistoryTargetKind;
  targetUuid: string;
  details?: HistoryDetails;
}

export async function recordHistory(tx: Tx, r: HistoryRecord): Promise<void> {
  await tx.execute(sql`
    INSERT INTO app.history (source, category, action, actor_user_id, owner_user_id, to_owner_user_id, guild_id, target_kind, target_uuid, details)
    VALUES (${r.source}, ${r.category}, ${r.action}, ${r.actorUserId}, ${r.ownerUserId}, ${r.toOwnerUserId ?? null}, ${r.guildId ?? null},
      ${r.targetKind}, ${r.targetUuid}, ${JSON.stringify(r.details ?? {})}::jsonb)`);
}
