// The data update of the singleuser variant (docs/singleuser.md "Updating the data"): asks the feed what is newest,
// plans (plan.ts), downloads into `<data>/downloads/`, verifies, installs (install.ts), cleans up. Its state is in
// memory, so the UI can show it while an install holds the database. One operation at a time (single flight).
import { mkdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { SNAPSHOT_SCHEMA_VERSION } from '../catalog/snapshot.ts';
import type { Connection } from '../db/connect-url.ts';
import type { DataUpdateFailure, DataUpdateOutcome, DataUpdateState } from '../webapp/api-types.ts';
import { Cancelled, FeedUnavailable, type DataFeed } from './feed.ts';
import { installPack, installedPack, type InstallResult } from './install.ts';
import { DataPackError, type Manifest, type ManifestFile } from './manifest.ts';
import { FeedInconsistent, planUpdate } from './plan.ts';

export interface DataUpdaterOptions {
  connection: Pick<Connection, 'db' | 'maintain'>;
  dataDir: string;
  /** `<dataDir>/thumbs`. */
  thumbsDir: string;
  feed: DataFeed;
  /** The snapshot schema version the app reads (`SNAPSHOT_SCHEMA_VERSION`). */
  appSchemaVersion?: number;
  /** One line of the update's log. */
  log: (message: string) => void;
}

export interface DataUpdater {
  /** A copy of the in-memory state. */
  state(): DataUpdateState;
  /** Resolves with the state when the check is done; while an operation runs, returns the running state at once. Never rejects. */
  check(): Promise<DataUpdateState>;
  /** Installs a full pack the user picked. Same single flight, same rules. */
  importFile(path: string): Promise<DataUpdateState>;
  /** Aborts a download and waits for the running operation (an install is not interrupted). */
  stop(): Promise<void>;
}

const mb = (bytes: number) => `${(bytes / 1_048_576).toFixed(1)} MB`;

export function createDataUpdater(options: DataUpdaterOptions): DataUpdater {
  const { connection, dataDir, thumbsDir, feed, log } = options;
  const appSchema = options.appSchemaVersion ?? SNAPSHOT_SCHEMA_VERSION;
  const downloads = join(dataDir, 'downloads');

  const installedNow = () => {
    const m = installedPack(dataDir);
    return m ? { tag: m.tag, gameLabel: m.game.label } : null;
  };
  let phase: DataUpdateState['phase'] = 'idle';
  let installed = installedNow();
  let progress: DataUpdateState['progress'] = null;
  let last: DataUpdateState['last'] = null;
  let running: Promise<void> | null = null;
  let abort = new AbortController();

  const clean = () => rmSync(downloads, { recursive: true, force: true });
  // What a crash left behind
  clean();

  const state = (): DataUpdateState => ({ phase, installed, progress: progress && { ...progress }, last: last && { ...last } });
  const finish = (outcome: DataUpdateOutcome) => {
    last = { at: new Date().toISOString(), ...outcome };
    log(`data update: ${JSON.stringify(outcome)}`);
  };

  const failure = (err: unknown): DataUpdateOutcome => {
    if (err instanceof FeedUnavailable) {
      log(`data update: feed not reachable: ${err.message}`);
      return { outcome: 'offline' };
    }
    log(`data update: failed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
    let reason: DataUpdateFailure = 'internal';
    if (err instanceof DataPackError) reason = err.code === 'checksum' ? 'corrupt' : err.code === 'unknownFormat' ? 'unsupported' : 'invalid';
    else if (err instanceof FeedInconsistent) reason = 'invalid';
    return { outcome: 'failed', reason };
  };

  const result = (r: InstallResult): DataUpdateOutcome => {
    if (r.status === 'appTooOld') {
      return { outcome: 'appTooOld', tag: r.tag, pack: r.packSchemaVersion > r.appSchemaVersion ? 'newer' : 'older' };
    }
    installed = installedNow();
    return { outcome: 'installed', tag: r.tag };
  };

  async function timed<T>(name: string, run: () => Promise<T>, detail?: string): Promise<T> {
    const start = performance.now();
    const r = await run();
    log(`data update: ${name}${detail ? ` ${detail}` : ''}: ${Math.round(performance.now() - start)} ms`);
    return r;
  }

  async function runCheck(signal: AbortSignal): Promise<DataUpdateOutcome> {
    const stable = await timed('check', () => feed.stableTag(signal));
    if (stable === null) return { outcome: 'noChannel' };
    const manifests = new Map<string, Manifest | null>();
    const plan = await planUpdate({
      installed: installed?.tag ?? null,
      appSchemaVersion: appSchema,
      newest: stable,
      manifestOf: async (tag) => {
        if (!manifests.has(tag)) manifests.set(tag, await feed.manifest(tag, signal));
        return manifests.get(tag)!;
      },
    });
    log(`data update: plan ${plan.kind}${plan.kind === 'full' ? ` (${plan.reason})` : plan.kind === 'chain' ? ` (${plan.manifests.length} releases, ${mb(plan.bytes)})` : ''}`);
    if (plan.kind === 'upToDate') return { outcome: 'upToDate' };
    if (plan.kind === 'appTooOld') return { outcome: 'appTooOld', tag: plan.manifest.tag, pack: plan.pack };

    // The downloads in install order
    const files: { tag: string; file: ManifestFile; dest: string }[] = [];
    const newest = plan.kind === 'full' ? plan.manifest : plan.manifests[plan.manifests.length - 1]!;
    mkdirSync(downloads, { recursive: true });
    if (plan.kind === 'full') {
      files.push({ tag: newest.tag, file: newest.files.full, dest: join(downloads, newest.files.full.name) });
    } else {
      files.push({ tag: newest.tag, file: newest.files.catalog, dest: join(downloads, `${newest.tag}.${newest.files.catalog.name}`) });
      for (const m of plan.manifests) files.push({ tag: m.tag, file: m.files.thumbs, dest: join(downloads, `${m.tag}.${m.files.thumbs.name}`) });
    }
    const total = files.reduce((sum, f) => sum + f.file.size, 0);
    phase = 'downloading';
    progress = { done: 0, total };
    await timed('download', async () => {
      let before = 0;
      for (const f of files) {
        await feed.download(f.tag, f.file, f.dest, { signal, onProgress: (n) => (progress = { done: before + n, total }) });
        before += f.file.size;
        progress = { done: before, total };
      }
    }, mb(total));
    progress = null;
    if (signal.aborted) throw new Cancelled();

    phase = 'installing';
    const source = plan.kind === 'full'
      ? { kind: 'full' as const, file: files[0]!.dest }
      : { kind: 'parts' as const, manifest: newest, catalog: files[0]!.dest, thumbsUpdates: files.slice(1).map((f) => f.dest) };
    return result(await timed('install', () => installPack({ connection, dataDir, thumbsDir, source })));
  }

  async function runImport(path: string): Promise<DataUpdateOutcome> {
    let isFile = false;
    try {
      isFile = statSync(path).isFile();
    } catch { /* not there */ }
    if (!isFile) return { outcome: 'failed', reason: 'fileMissing' };
    return result(await timed('import', () => installPack({ connection, dataDir, thumbsDir, source: { kind: 'full', file: path } })));
  }

  /**
   * Single flight: starts `work` unless one runs (then the running state comes back at once). The phase is set before
   * `work` starts, and `work` starts on a later turn of the event loop: the caller's answer is not held up by the
   * synchronous part of it (opening and checking a pack).
   */
  function operate(first: DataUpdateState['phase'], work: (signal: AbortSignal) => Promise<DataUpdateOutcome>): Promise<DataUpdateState> {
    if (running) return Promise.resolve(state());
    abort = new AbortController();
    const signal = abort.signal;
    phase = first;
    const own = (async () => {
      try {
        await new Promise<void>((resolve) => setImmediate(resolve));
        finish(await work(signal));
      } catch (err) {
        if (err instanceof Cancelled) log('data update: cancelled');
        else finish(failure(err));
      } finally {
        progress = null;
        phase = 'idle';
        clean();
        running = null;
      }
    })();
    // The first await above yields: this runs before the finally
    running = own;
    return own.then(state);
  }

  return {
    state,
    check: () => operate('checking', runCheck),
    importFile: (path) => operate('installing', () => runImport(path)),
    async stop() {
      abort.abort();
      await running;
    },
  };
}
