// The bot's Discord status: a random text from bot.status_quote (edited in the admin UI), changed every
// 10 minutes. Read fresh each time, so edits show with the next change; no texts = no status.
import { ActivityType, type Client } from 'discord.js';
import { sql } from 'drizzle-orm';
import type { Db } from '../db/client.ts';
import { one } from '../db/query.ts';

type Log = (message: string, err?: unknown) => void;

const INTERVAL_MS = 10 * 60_000;

/** A random text; the one shown last only when it is the only one. */
export function pickQuote(db: Db, lastId: number | null): Promise<{ id: number; text: string } | null> {
  return one(db, sql`
    SELECT id::int AS id, text FROM bot.status_quote
    ORDER BY id IS NOT DISTINCT FROM ${lastId}, random() LIMIT 1`);
}

export class StatusRotator {
  private readonly client: Client;
  private readonly db: Db;
  private readonly log: Log;
  private timer: ReturnType<typeof setInterval> | null = null;
  private current: { id: number; text: string } | null = null;

  constructor(client: Client, db: Db, log: Log) {
    this.client = client;
    this.db = db;
    this.log = log;
  }

  start() {
    this.timer ??= setInterval(() => void this.next(), INTERVAL_MS);
    void this.next();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** A new gateway session starts without a status (discord.js only sends the one from the login options). */
  reapply() {
    if (this.timer) this.show();
  }

  private async next(): Promise<void> {
    try {
      this.current = await pickQuote(this.db, this.current?.id ?? null);
      this.show();
    } catch (err) {
      this.log('Status change failed', err);
    }
  }

  private show() {
    const text = this.current?.text;
    this.client.user?.setPresence({ activities: text ? [{ type: ActivityType.Custom, name: 'Custom Status', state: text }] : [] });
  }
}
