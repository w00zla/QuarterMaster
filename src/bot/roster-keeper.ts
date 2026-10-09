// Keeps the roster current: full syncs from the member list and the member events in between. Full
// syncs and member events of one guild run one after another: a sync working from an older member list
// must not overwrite a newer event. A failed sync or event is retried with a full sync.
import { setTimeout as sleep } from 'node:timers/promises';
import type { Guild } from 'discord.js';
import type { Db } from '../db/client.ts';
import { syncGuild, syncMemberEvent, type MemberInfo } from './roster.ts';
import { findGuildSettings } from './settings.ts';

const RETRY_MS = 5 * 60_000;
// Discord answers a guild's member list request (gateway opcode 8) about once per 30 s
const FETCH_GAP_MS = 31_000;

type Log = (message: string, err?: unknown) => void;
type Loader = { name: string; load: () => Promise<MemberInfo[]> };

export class RosterKeeper {
  private readonly db: Db;
  private readonly log: Log;
  private readonly queues = new Map<string, Promise<void>>();
  private readonly loaders = new Map<string, Loader>();
  // A full sync queued but not started yet: later requests join it (it fetches when it runs)
  private readonly waiting = new Map<string, Promise<void>>();
  private readonly lastFetch = new Map<string, number>();
  private readonly fetchGapMs: number;
  private readonly retries = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(db: Db, log: Log, options: { fetchGapMs?: number } = {}) {
    this.db = db;
    this.log = log;
    this.fetchGapMs = options.fetchGapMs ?? FETCH_GAP_MS;
  }

  /** Full sync from a fresh member list (fetched when the sync runs, after everything queued before it). */
  fullSync(guildId: string, name: string, load: () => Promise<MemberInfo[]>): Promise<void> {
    this.loaders.set(guildId, { name, load });
    clearTimeout(this.retries.get(guildId));
    this.retries.delete(guildId);
    const waiting = this.waiting.get(guildId);
    if (waiting) return waiting;
    const run = this.enqueue(guildId, async () => {
      this.waiting.delete(guildId);
      try {
        const settings = await findGuildSettings(this.db, guildId);
        // No setup: no org, no roster
        if (!settings) return;
        const wait = (this.lastFetch.get(guildId) ?? 0) + this.fetchGapMs - Date.now();
        if (wait > 0) await sleep(wait);
        this.lastFetch.set(guildId, Date.now());
        const counts = await syncGuild(this.db, guildId, settings, await load());
        this.log(`Roster ${name}: ${JSON.stringify(counts)}`);
      } catch (err) {
        this.log(`Roster sync failed for ${name} (${guildId}), retrying in ${RETRY_MS / 60_000} min`, err);
        this.scheduleRetry(guildId);
      }
    });
    this.waiting.set(guildId, run);
    return run;
  }

  /** Member joined, changed or left (null). A failed update is caught up by a full sync. */
  memberEvent(guildId: string, userId: string, info: MemberInfo | null): Promise<void> {
    return this.enqueue(guildId, () => syncMemberEvent(this.db, guildId, userId, info)).catch((err: unknown) => {
      this.log(`Roster update failed for ${guildId}/${userId}`, err);
      this.scheduleRetry(guildId);
    });
  }

  /** Shutdown: no more retries. */
  stop() {
    for (const timer of this.retries.values()) clearTimeout(timer);
    this.retries.clear();
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
}

// /qm-setup asks for a full sync after a role change; main.ts answers it with its keeper
let fullSyncHandler: ((guild: Guild) => void) | null = null;
export const onFullSyncRequest = (handler: (guild: Guild) => void) => (fullSyncHandler = handler);
export const requestFullSync = (guild: Guild) => fullSyncHandler?.(guild);
