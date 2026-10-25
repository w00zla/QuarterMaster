// Read side of a user's history (app.history, written by src/history/record.ts): the user's own
// actions, what others did to the user's data and what was shared in the user's orgs, newest first,
// with display names in the language (materials, locations and blueprints from the shared catalogs, retired ones from the
// catalog tables; people by their name in the org).
import { sql } from 'drizzle-orm';
import type { Db } from '../db/client.ts';
import { rows } from '../db/query.ts';
import { blueprintCatalog } from '../bot/blueprints.ts';
import type { Lang } from '../bot/i18n.ts';
import type { HistoryDetails } from '../history/record.ts';
import { formatAmount } from '../stock/amount.ts';
import { locationCatalog, materialCatalog, missingNames } from '../stock/lookup.ts';
import type { HistoryCategory, HistoryEntry, HistoryPerson, HistoryResponse, HistorySource } from './api-types.ts';

export const HISTORY_PAGE = 100;

export interface HistoryFilter {
  source?: HistorySource;
  category?: HistoryCategory;
  action?: string;
  // Who did it: you, or someone else (to your data)
  by?: 'me' | 'others';
  // Only entries newer than this id (the notices fetch what they were told about in one go)
  after?: number;
}

interface Row {
  id: number;
  at: Date;
  source: HistorySource;
  category: HistoryCategory;
  action: string;
  actorUserId: string;
  ownerUserId: string;
  toOwnerUserId: string | null;
  targetKind: 'resource' | 'item' | 'blueprint';
  targetUuid: string;
  details: HistoryDetails;
  org: string | null;
  actorName: string | null;
  ownerName: string | null;
  toOwnerName: string | null;
}

export async function listHistory(db: Db, userId: string, lang: Lang, before?: number, filter: HistoryFilter = {}): Promise<HistoryResponse> {
  const found = await rows<Row>(db, sql`
    SELECT h.id::int AS id, h.created_at AS at, h.source, h.category, h.action, h.actor_user_id AS "actorUserId",
      h.owner_user_id AS "ownerUserId", h.to_owner_user_id AS "toOwnerUserId", h.target_kind AS "targetKind",
      h.target_uuid AS "targetUuid", h.details, o.name AS org, ma.display_name AS "actorName", mo.display_name AS "ownerName",
      mt.display_name AS "toOwnerName"
    FROM app.history h
    LEFT JOIN app.org o ON o.guild_id = h.guild_id
    LEFT JOIN app.member ma ON ma.guild_id = h.guild_id AND ma.user_id = h.actor_user_id
    LEFT JOIN app.member mo ON mo.guild_id = h.guild_id AND mo.user_id = h.owner_user_id
    LEFT JOIN app.member mt ON mt.guild_id = h.guild_id AND mt.user_id = h.to_owner_user_id
    WHERE (h.actor_user_id = ${userId} OR h.owner_user_id = ${userId} OR h.to_owner_user_id = ${userId}
      -- What others shared in your orgs
      OR (h.action = 'share' AND h.guild_id IN (SELECT guild_id FROM app.member WHERE user_id = ${userId} AND active)))
      ${before === undefined ? sql`` : sql`AND h.id < ${before}`}
      ${filter.after === undefined ? sql`` : sql`AND h.id > ${filter.after}`}
      ${filter.source ? sql`AND h.source = ${filter.source}` : sql``}
      ${filter.category ? sql`AND h.category = ${filter.category}` : sql``}
      ${filter.action ? sql`AND h.action = ${filter.action}` : sql``}
      ${filter.by === 'me' ? sql`AND h.actor_user_id = ${userId}` : filter.by === 'others' ? sql`AND h.actor_user_id <> ${userId}` : sql``}
    ORDER BY h.id DESC
    LIMIT ${HISTORY_PAGE + 1}`);
  const page = found.slice(0, HISTORY_PAGE);

  const [materials, locations, blueprints] = [
    await materialCatalog(db, lang), await locationCatalog(db, lang), await blueprintCatalog(db, lang),
  ];
  const subjects = new Set<string>();
  const places = new Set<string>();
  for (const r of page) {
    if (r.targetKind !== 'blueprint') subjects.add(r.targetUuid);
    if (r.details.oreUuid) subjects.add(r.details.oreUuid);
    for (const l of [r.details.locationUuid, r.details.toLocationUuid]) if (l) places.add(l);
  }
  const fallback = await missingNames(db, lang, [...subjects].filter((u) => !materials.has(u)), [...places].filter((u) => !locations.has(u)));
  const material = (uuid: string) => materials.get(uuid)?.name ?? fallback.get(uuid) ?? uuid;
  const place = (uuid: string | undefined) => (uuid ? locations.get(uuid)?.short ?? fallback.get(uuid) ?? uuid : null);
  const amount = (text: string | null | undefined) => (text ? formatAmount(text) : null);
  const person = (id: string, name: string | null): HistoryPerson => ({ userId: id, name: name ?? '?' });

  const entries = page.map((r): HistoryEntry => {
    const d = r.details;
    const blueprint = r.targetKind === 'blueprint';
    // Sharing (since 0017 a row per org, without designations) reads like a move into or out of the org
    const shared = r.action === 'share' ? ['personal', 'org'] as const : r.action === 'unshare' ? ['org', 'personal'] as const : null;
    const designation = shared?.[0] ?? d.designation ?? null;
    const toDesignation = shared?.[1] ?? d.toDesignation ?? null;
    // Shared stock and gives name the people involved
    const named = designation === 'org' || toDesignation === 'org' || r.action === 'give';
    return {
      id: r.id,
      at: new Date(r.at).toISOString(),
      source: r.source,
      category: r.category,
      action: r.action,
      actor: person(r.actorUserId, r.actorName),
      org: r.org,
      target: blueprint ? blueprints.byUuid.get(r.targetUuid)?.label ?? r.targetUuid : material(r.targetUuid),
      targetUuid: r.targetUuid,
      unit: blueprint ? null : r.targetKind === 'resource' ? 'SCU' : 'pcs',
      amount: amount(d.amount),
      quality: d.quality ?? null,
      location: place(d.locationUuid),
      designation,
      holder: named ? person(r.ownerUserId, r.ownerName) : null,
      toLocation: d.toLocationUuid && d.toLocationUuid !== d.locationUuid ? place(d.toLocationUuid) : null,
      toDesignation: toDesignation && toDesignation !== designation ? toDesignation : null,
      toHolder: named && r.toOwnerUserId ? person(r.toOwnerUserId, r.toOwnerName) : null,
      from: amount(d.from),
      durationSeconds: d.durationSeconds ?? null,
      expectedYield: amount(d.expectedYield),
      ore: d.oreUuid ? material(d.oreUuid) : null,
      oreAmount: amount(d.oreAmount),
      oreQuality: d.oreQuality ?? null,
    };
  });
  return { entries, more: found.length > HISTORY_PAGE };
}
