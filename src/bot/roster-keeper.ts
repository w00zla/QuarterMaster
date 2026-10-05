// Keeps the roster current and says, per org, when it is. `app.org.roster_checked_at` is refreshed
// every minute only while the bot can vouch for that org's roster (its guild reachable, the last
// full sync succeeded, no further one pending) and cleared the moment it cannot (shard reconnecting,
// guild unavailable or left, sync starting or failed). The user web app treats an org whose value is
// older than a few minutes as read-only (src/webapp/me.ts).
// Full syncs and member events of one guild run one after another: a sync working from an older
// member list must not overwrite a newer event.
import { setTimeout as sleep } from 'node:timers/promises';
import { inArray, sql } from 'drizzle-orm';
import type { Guild } from 'discord.js';
import type { Db } from '../db/client.ts';
import { org } from '../db/schema/app.ts';
import { syncGuild, syncMemberEvent, type MemberInfo } from './roster.ts';
import { findGuildSettings } from './settings.ts';

export const BEAT_INTERVAL_MS = 60_000;
const RETRY_MS = 5 * 60_000;
// Discord answers a guild's member list request (gateway opcode 8) about once per 30 s
const FETCH_GAP_MS = 31_000;

type Log = (message: string, err?: unknown) => void;
type Loader = { name: string; load: () => Promise<MemberInfo[]> };

export class RosterKeeper {
  private readonly db: Db;
  // Whether the guild is reachable right now (its shard connected, guild available)
  private readonly reachable: (guildId: string) => boolean;
  private readonly log: Log;
  // Guilds whose roster the bot vouches for
  private readonly current = new Set<string>();
  private readonly pendingSyncs = new Map<string, number>();
  private readonly queues = new Map<string, Promise<void>>();
  private readonly loaders = new Map<string, Loader>();
  // A full sync queued but not started yet: later requests join it (it fetches when it runs)
  private readonly waiting = new Map<string, Promise<void>>();
  private readonly lastFetch = new Map<string, number>();
  private readonly fetchGapMs: number;
  private readonly retries = new Map<string, ReturnType<typeof setTimeout>>();
  // Freshness writes in order: a beat must never land after a later invalidation
  private writes: Promise<void> = Promise.resolve();

  constructor(db: Db, reachable: (guildId: string) => boolean, log: Log, options: { fetchGapMs?: number } = {}) {
    this.db = db;
    this.reachable = reachable;
    this.log = log;
    this.fetchGapMs = options.fetchGapMs ?? FETCH_GAP_MS;
  }

  /** From now on the bot cannot vouch for these guilds' rosters. */
  invalidate(guildIds: string[]): Promise<void> {
    for (const id of guildIds) this.current.delete(id);
    if (!guildIds.length) return this.writes;
    return this.write(() => this.db.update(org).set({ rosterCheckedAt: null }).where(inArray(org.guildId, guildIds)));
  }

  /** Refreshes every guild the bot vouches for and can reach (every minute and after a sync). */
  beat(): Promise<void> {
    return this.write(async () => {
      // Decided when the write runs, not when it was queued
      const ids = [...this.current].filter(this.reachable);
      if (ids.length) await this.db.update(org).set({ rosterCheckedAt: sql`now()` }).where(inArray(org.guildId, ids));
    });
  }

  /** Full sync from a fresh member list (fetched when the sync runs, after everything queued before it). */
  fullSync(guildId: string, name: string, load: () => Promise<MemberInfo[]>): Promise<void> {
    this.loaders.set(guildId, { name, load });
    clearTimeout(this.retries.get(guildId));
    this.retries.delete(guildId);
    const waiting = this.waiting.get(guildId);
    if (waiting) return waiting;
    this.pendingSyncs.set(guildId, (this.pendingSyncs.get(guildId) ?? 0) + 1);
    void this.invalidate([guildId]);
    const run = this.enqueue(guildId, async () => {
      this.waiting.delete(guildId);
      let ok = false;
      try {
        const settings = await findGuildSettings(this.db, guildId);
        // No setup: no org, no roster to vouch for
        if (!settings) return;
        const wait = (this.lastFetch.get(guildId) ?? 0) + this.fetchGapMs - Date.now();
        if (wait > 0) await sleep(wait);
        this.lastFetch.set(guildId, Date.now());
        const counts = await syncGuild(this.db, guildId, settings, await load());
        this.log(`Roster ${name}: ${JSON.stringify(counts)}`);
        ok = true;
      } catch (err) {
        this.log(`Roster sync failed for ${name} (${guildId}), retrying in ${RETRY_MS / 60_000} min`, err);
        this.scheduleRetry(guildId);
      } finally {
        const left = (this.pendingSyncs.get(guildId) ?? 1) - 1;
        if (left) this.pendingSyncs.set(guildId, left);
        else this.pendingSyncs.delete(guildId);
        // Only the last pending sync vouches: an earlier one may predate what triggered the later
        if (ok && !left) {
          this.current.add(guildId);
          void this.beat();
        }
      }
    });
    this.waiting.set(guildId, run);
    return run;
  }

  /** Member joined, changed or left (null). A failed update makes the roster stale until a full sync. */
  memberEvent(guildId: string, userId: string, info: MemberInfo | null): Promise<void> {
    return this.enqueue(guildId, () => syncMemberEvent(this.db, guildId, userId, info)).catch((err: unknown) => {
      this.log(`Roster update failed for ${guildId}/${userId}`, err);
      void this.invalidate([guildId]);
      this.scheduleRetry(guildId);
    });
  }

  /** Shutdown: nobody vouches any more. */
  async stop() {
    for (const timer of this.retries.values()) clearTimeout(timer);
    this.retries.clear();
    await this.invalidate([...this.current]);
  }

  private scheduleRetry(guildId: string) {
    const loader = this.loaders.get(guildId);
    if (!loader || this.retries.has(guildId)) return;
    const timer = setTimeout(() => {
      this.retries.delete(guildId);
      void this.fullSync(guildId, loader.name, loader.load);
    }, RETRY_MS);
    timer.unref();
    this.retries.set(guildId, timer);
  }

  private enqueue(guildId: string, job: () => Promise<void>): Promise<void> {
    const run = (this.queues.get(guildId) ?? Promise.resolve()).then(job);
    const settled = run.catch(() => {});
    this.queues.set(guildId, settled);
    void settled.then(() => {
      if (this.queues.get(guildId) === settled) this.queues.delete(guildId);
    });
    return run;
  }

  private write(job: () => Promise<unknown>): Promise<void> {
    this.writes = this.writes.then(job).then(
      () => {},
      (err: unknown) => this.log('Roster freshness write failed', err),
    );
    return this.writes;
  }
}

// /qm-setup asks for a full sync after a role change; main.ts answers it with its keeper
let fullSyncHandler: ((guild: Guild) => void) | null = null;
export const onFullSyncRequest = (handler: (guild: Guild) => void) => (fullSyncHandler = handler);
export const requestFullSync = (guild: Guild) => fullSyncHandler?.(guild);
