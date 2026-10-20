// The texts the bot shows as its Discord status (bot.status_quote, src/bot/status.ts): list, add, change, delete.
import { sql } from 'drizzle-orm';
import type { Db } from '../db/client.ts';
import { one, rows } from '../db/query.ts';
import type { StatusQuote } from './api-types.ts';

// Discord's limit for a custom status (the table's CHECK)
export const MAX_QUOTE_LENGTH = 128;

const COLUMNS = sql`id::int AS id, text, to_json(created_at) #>> '{}' AS "createdAt", to_json(updated_at) #>> '{}' AS "updatedAt"`;

/** The trimmed text, or null when it is empty or too long. */
export function quoteText(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  return text.length >= 1 && [...text].length <= MAX_QUOTE_LENGTH ? text : null;
}

export function getStatusQuotes(db: Db): Promise<StatusQuote[]> {
  return rows(db, sql`SELECT ${COLUMNS} FROM bot.status_quote ORDER BY id`);
}

export async function addStatusQuote(db: Db, text: string): Promise<StatusQuote> {
  return (await one<StatusQuote>(db, sql`INSERT INTO bot.status_quote (text) VALUES (${text}) RETURNING ${COLUMNS}`))!;
}

/** Null = no such row. */
export function updateStatusQuote(db: Db, id: number, text: string): Promise<StatusQuote | null> {
  return one(db, sql`UPDATE bot.status_quote SET text = ${text}, updated_at = now() WHERE id = ${id} RETURNING ${COLUMNS}`);
}

/** False = no such row. */
export async function deleteStatusQuote(db: Db, id: number): Promise<boolean> {
  return (await rows(db, sql`DELETE FROM bot.status_quote WHERE id = ${id} RETURNING id`)).length > 0;
}
