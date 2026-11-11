// The UEX pull of the singleuser variant (docs/singleuser.md "UEX"): the only optional network use of the app. It runs
// only while the user has entered his own UEX key, at start and every N minutes, and on request. The pull itself is the
// online puller's (`pullUex`); this file adds the schedule, the in-memory state and the mapping of a pull's result to a
// few outcomes the settings view can show. Everything it needs is passed in; it never throws into the process.
import type { Db } from '../db/client.ts';
import { pullUex } from '../ext/uex.ts';
import type { UexOutcome, UexState } from '../webapp/api-types.ts';

export interface UexTimers {
  setTimeout(run: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface UexPullerOptions {
  db: Db;
  /** CHECKPOINT and VACUUM (`Connection.maintain`); called after a pull that stored something new, never inside a transaction. */
  maintain: () => Promise<void>;
  /** The current settings (read at every decision, so a change is seen at once). */
  settings: () => { uexKey: string | null; uexIntervalMinutes: number };
  /** The only way a request leaves this module. */
  fetch: typeof fetch;
  log: (message: string) => void;
  /** Replaceable for tests. */
  now?: () => Date;
  timers?: UexTimers;
}

export interface UexPuller {
  /** A copy of the in-memory state. */
  state(): UexState;
  /** Starts the schedule: pulls at once when a key is set, then every N minutes. Resolves when that first pull is done. */
  start(): Promise<void>;
  /** Pulls now. Without a key, before `start()` and while a pull runs, nothing new starts. The state is `pulling` when this returns. */
  pullNow(): Promise<void>;
  /** The settings changed: a new key pulls now, a removed key stops everything, a new interval restarts the wait. */
  reconfigure(): Promise<void>;
  /** Stops the timer, aborts the requests and waits for a running pull. */
  stop(): Promise<void>;
}

const DEFAULT_TIMERS: UexTimers = {
  setTimeout: (run, ms) => {
    const handle = setTimeout(run, ms);
    handle.unref();
    return handle;
  },
  clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
};

/** What one HTTP exchange of a pull came to: the status, or that the request failed before there was one. */
type Exchange = { status: number } | { error: true };

export function createUexPuller(options: UexPullerOptions): UexPuller {
  const { db, maintain, log } = options;
  const now = options.now ?? (() => new Date());
  const timers = options.timers ?? DEFAULT_TIMERS;

  let phase: UexState['phase'] = 'off';
  let lastPull: string | null = null;
  let nextPull: string | null = null;
  let last: UexState['last'] = null;
  let timer: unknown = null;
  let running: Promise<void> | null = null;
  let active = false;
  let aborter = new AbortController();
  // The key and interval the schedule was made for, to see what a settings change is
  let appliedKey: string | null = null;
  let appliedInterval = 0;
  // A new key arrived while a pull with the old one ran: pull again when it is done
  let again = false;

  const state = (): UexState => ({ phase, lastPull, nextPull, last: last && { ...last } });
  const iso = (ms: number) => new Date(ms).toISOString();

  const clearTimer = () => {
    if (timer !== null) timers.clearTimeout(timer);
    timer = null;
  };

  /** Waits for the next pull, or goes `off` without a key. */
  function schedule(): void {
    clearTimer();
    const { uexKey, uexIntervalMinutes } = options.settings();
    appliedKey = uexKey;
    appliedInterval = uexIntervalMinutes;
    nextPull = null;
    if (!active || uexKey === null) {
      phase = 'off';
      return;
    }
    phase = 'idle';
    const ms = uexIntervalMinutes * 60_000;
    nextPull = iso(now().getTime() + ms);
    timer = timers.setTimeout(() => void pullNow(), ms);
  }

  /** The outcome of a finished pull from what its requests came to. */
  function outcomeOf(failed: number, exchanges: Exchange[]): UexOutcome {
    if (failed === 0) return 'ok';
    const refused = (e: Exchange) => 'status' in e && (e.status === 401 || e.status === 403);
    if (exchanges.length > 0 && exchanges.every(refused)) return 'refused';
    // Every endpoint that failed did so without an answer (no network, DNS, timeout)
    const unanswered = exchanges.filter((e) => 'error' in e).length;
    if (unanswered > 0 && unanswered >= failed) return 'offline';
    return 'failed';
  }

  async function runPull(key: string): Promise<void> {
    const started = performance.now();
    const startedAt = now().getTime();
    const exchanges: Exchange[] = [];
    const signal = aborter.signal;
    const recording: typeof fetch = async (input, init) => {
      try {
        const res = await options.fetch(input, { ...init, signal: init?.signal ? AbortSignal.any([init.signal, signal]) : signal });
        exchanges.push({ status: res.status });
        return res;
      } catch (err) {
        exchanges.push({ error: true });
        throw err;
      }
    };
    let outcome: UexOutcome;
    let changed: number | undefined;
    try {
      const result = await pullUex(db, key, recording);
      changed = result.inserted;
      outcome = outcomeOf(result.failed, exchanges);
      if (result.inserted > 0) {
        try {
          await maintain();
        } catch (err) {
          log(`uex: maintenance failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    } catch (err) {
      // Not an endpoint's failure (pullUex counts those): the database, for one
      log(`uex: pull failed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
      outcome = 'failed';
    }
    log(`uex pull: ${outcome}${changed !== undefined ? `, ${changed} changed` : ''}, ${Math.round(performance.now() - started)} ms`);
    // A key that was removed or replaced while this ran: its result says nothing about the current key
    if (options.settings().uexKey === key) {
      lastPull = iso(startedAt);
      last = { outcome, at: iso(now().getTime()), ...(changed !== undefined ? { changed } : {}) };
    }
  }

  /** Single flight: starts a pull unless one runs, there is no key or the puller is not started. */
  function pullNow(): Promise<void> {
    if (running) return running;
    const key = options.settings().uexKey;
    if (!active || key === null) return Promise.resolve();
    clearTimer();
    nextPull = null;
    phase = 'pulling';
    aborter = new AbortController();
    const own = (async () => {
      try {
        await Promise.resolve();
        await runPull(key);
      } catch (err) {
        log(`uex: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        running = null;
        if (again && active) {
          again = false;
          void pullNow();
        } else {
          schedule();
        }
      }
    })();
    running = own;
    return own;
  }

  return {
    state,
    async start() {
      active = true;
      schedule();
      await pullNow();
    },
    pullNow,
    async reconfigure() {
      if (!active) return;
      const { uexKey, uexIntervalMinutes } = options.settings();
      if (uexKey === appliedKey && uexIntervalMinutes === appliedInterval) return;
      if (uexKey === null) {
        // A running pull is aborted; its end finds no key and stays off
        again = false;
        aborter.abort();
        clearTimer();
        appliedKey = null;
        nextPull = null;
        phase = 'off';
      } else if (uexKey !== appliedKey) {
        appliedKey = uexKey;
        appliedInterval = uexIntervalMinutes;
        if (running) {
          again = true;
          aborter.abort();
        } else {
          await pullNow();
        }
      } else if (running) {
        // Only the interval: the end of the running pull schedules with the new one
        appliedInterval = uexIntervalMinutes;
      } else {
        schedule();
      }
    },
    async stop() {
      active = false;
      again = false;
      clearTimer();
      aborter.abort();
      await running;
      nextPull = null;
    },
  };
}
