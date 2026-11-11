// The singleuser variant: one local process serving the web app and its API on PGlite for one fixed user (the local
// identity). Binds to 127.0.0.1 only. One process per data folder (PGlite has no second opener): docs/singleuser.md.
import { mkdirSync, readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import type { Server } from 'node:http';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import { sql } from 'drizzle-orm';
import { connectPglite } from '../db/pglite.ts';
import { folderFeed, githubFeed } from '../datapack/feed.ts';
import { createDataUpdater } from '../datapack/updater.ts';
import { createApp } from '../webapp/app.ts';
import { localIdentity } from '../webapp/identity-local.ts';
import { RealtimeHub, listenForChanges } from '../webapp/realtime.ts';
import { mountDataRoutes } from './data-routes.ts';
import { describeGameFolder, readLanguagePack } from './game-folder.ts';
import { syncLanguagePack } from './language-pack.ts';
import { acquireLock, lockFile, releaseLock } from './lock.ts';
import { cspConnect, dataDir, dbDir, thumbsDir } from './paths.ts';
import { pairingFile, removePairing, writePairing } from './pairing.ts';
import { choosePort } from './port.ts';
import { createSettingsStore, settingsFile } from './settings.ts';
import { mountSettingsRoutes, type LoadedPack } from './settings-routes.ts';
import { createUexPuller } from './uex.ts';
import { mountUexRoutes } from './uex-routes.ts';

const HOST = '127.0.0.1';

// Set by the bundle (scripts: src/singleuser/app-bundle.ts), which has no package.json beside it
declare const __QM_APP_VERSION__: string | undefined;

/**
 * A start failure with a stable code. `QM_FATAL <code>` goes to stdout before the process exits (docs/singleuser.md "The start
 * protocol"): `portsBusy`, `locked`, `database`, `config`, else `internal`.
 */
class StartError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

/** The protocol: one line each on stdout, machine-readable, beside the human log lines. */
const protocol = (line: string) => console.log(line);

/** One compact line per loading step, with its duration. */
async function step<T>(name: string, run: () => Promise<T>, fatal?: string): Promise<T> {
  const start = performance.now();
  let result: T;
  try {
    result = await run();
  } catch (err) {
    if (fatal === undefined) throw err;
    throw new StartError(fatal, `${name} failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  console.log(`${name}: ${Math.round(performance.now() - start)} ms`);
  return result;
}

const log = (message: string, err?: unknown) => (err === undefined ? console.log(message) : console.error(message, err));

async function main() {
  const started = performance.now();
  const data = dataDir(process.env, process.platform, homedir());
  mkdirSync(data, { recursive: true });
  // Before the database is touched: a taken port must not cost an open
  const port = await choosePort(process.env).catch((err: unknown) => {
    throw new StartError('portsBusy', err instanceof Error ? err.message : String(err));
  });
  const origin = `http://${HOST}:${port}`;
  console.log(`data folder: ${data}`);
  const extraConnectSrc = (() => {
    try {
      return cspConnect(process.env.QM_CSP_CONNECT);
    } catch (err) {
      throw new StartError('config', err instanceof Error ? err.message : String(err));
    }
  })();

  // One process per data folder: the lock is released after the database is closed (below), or at the latest when the process ends
  const lock = lockFile(data);
  const taken = await acquireLock(lock, { pid: process.pid, port, startedAt: Date.now() });
  if (!taken.taken) {
    throw new StartError('locked', `Quartermaster is already running on this data folder (process ${taken.holder.pid}, port ${taken.holder.port}): ${data}`);
  }
  const unlock = () => releaseLock(lock, process.pid);
  process.on('exit', unlock);

  // The settings, the game folder and the language pack: read once, at start (docs/singleuser.md "The game folder")
  const settings = createSettingsStore(settingsFile(data), process.env, (m) => log(m));
  const { gameDir, autoUpdate } = settings.get();
  let t = performance.now();
  const gameFolder = describeGameFolder(gameDir);
  console.log(`game folder: ${gameDir ?? 'not set'}: ${gameFolder.state}${gameFolder.problem ? ` (${gameFolder.problem})` : ''}${gameFolder.gameVersion ? `, game ${gameFolder.gameVersion}` : ''} (${Math.round(performance.now() - t)} ms)`);
  t = performance.now();
  // The pack's texts are synced into the database before the server listens (below)
  const languagePack: LoadedPack = { gameDir, pack: gameFolder.state === 'ok' && gameDir !== null ? readLanguagePack(gameDir) : null, active: false };
  const pack = languagePack.pack;
  console.log(`language pack: ${pack === null ? 'not read' : pack.texts ? `${pack.language}, ${pack.texts.size} texts` : `none (${pack.problem})`} (${Math.round(performance.now() - t)} ms)`);
  const pairing = pairingFile(process.env, process.platform, homedir());

  const connection = connectPglite(dbDir(data));
  const { db, client, migrate, close } = connection;
  try {
    // PGlite opens lazily: the first query is the open
    protocol('QM_STEP database');
    await step('open database', () => db.execute(sql`SELECT 1`), 'database');
    protocol('QM_STEP migrations');
    await step('migrations', () => migrate(process.env.QM_MIGRATIONS_DIR || fileURLToPath(new URL('../../drizzle', import.meta.url))), 'database');
    await step('checkpoint', () => db.execute(sql`CHECKPOINT`), 'database');
    // The language pack: stored as a source above the game's English, before any request is answered
    protocol('QM_STEP languagePack');
    await syncLanguagePack(connection, pack, log);
    languagePack.active = pack?.texts != null;
    const identity = await localIdentity(db);

    // The data update: the only thing in this process that uses the network (the GitHub feed, or QM_DATA_FEED: a folder)
    const feed = process.env.QM_DATA_FEED ? folderFeed(process.env.QM_DATA_FEED) : githubFeed({ fetch });
    const updater = createDataUpdater({ connection, dataDir: data, thumbsDir: join(data, 'thumbs'), feed, log: (m) => log(m) });
    // UEX, the only optional network use: the puller runs only while the user's key is set (docs/singleuser.md "UEX")
    const uex = createUexPuller({ db, maintain: connection.maintain, settings: () => settings.get(), fetch, log: (m) => log(m) });
    const appVersion = typeof __QM_APP_VERSION__ === 'string'
      ? __QM_APP_VERSION__
      : (JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string }).version;

    // The Host guard (DNS rebinding): only the names of this machine, with the port
    const allowedHosts = [`127.0.0.1:${port}`, `localhost:${port}`];
    const app = createApp(db, identity, {
      origin,
      trustProxy: false,
      distDir: process.env.QM_DIST_DIR || fileURLToPath(new URL('../../webapp/dist', import.meta.url)),
      extraConnectSrc,
      thumbsDir: thumbsDir(process.env, data),
      // UEX follows the key at runtime; orgs never change
      capabilities: () => ({ login: 'none', orgs: false, uex: settings.get().uexKey !== null }),
      // One local user: the limits must never bite (the mechanism stays)
      rateLimit: { windowMs: 60_000, auth: 100_000, apiIp: 100_000, apiUser: 100_000 },
      allowedHosts,
      mountApi: (api) => {
        mountDataRoutes(updater)(api);
        mountUexRoutes(uex)(api);
        mountSettingsRoutes({
          store: settings,
          loaded: languagePack,
          onGameDirChange: (dir) => writePairingFile(origin, dir),
          onUexChange: () => void uex.reconfigure(),
          appVersion,
        })(api);
      },
    });
    // A failing pairing file must not stop the server: the companion just cannot find it
    const writePairingFile = (o: string, dir: string | null) => {
      try {
        writePairing(pairing, { origin: o, gameDir: dir });
      } catch (err) {
        log('pairing file: cannot write it', err);
      }
    };
    const realtime = new RealtimeHub(db, identity, { origin, trustProxy: false, allowedHosts }, log);
    await listenForChanges(client, realtime, log);

    protocol('QM_STEP listen');
    const server = serve({ fetch: app.fetch, hostname: HOST, port }) as Server;
    // WebSocket handshakes bypass Hono (realtime.ts checks them itself)
    server.on('upgrade', (req, socket, head) => realtime.handleUpgrade(req, socket, head));
    await step('listen', () => new Promise<void>((resolve, reject) => {
      server.once('listening', resolve);
      server.once('error', reject);
    }));
    console.log(`listening on ${origin} (started in ${Math.round(performance.now() - started)} ms)`);
    protocol(`QM_READY ${origin}`);
    writePairingFile(origin, gameDir);
    // In the background: the start never waits for the network
    if (autoUpdate) void updater.check();
    else console.log('automatic update: off');
    // Also in the background; without a key it requests nothing
    void uex.start();
    console.log(`uex: ${uex.state().phase === 'off' ? 'off (no key)' : `pull at start, then every ${settings.get().uexIntervalMinutes} minutes`}`);

    let stopping = false;
    const shutdown = (signal: string) => {
      if (stopping) return;
      stopping = true;
      console.log(`${signal}: shutting down`);
      // Never hang: if closing takes longer than this, leave anyway (an install in progress gets its time: it is finished, not cut)
      setTimeout(() => process.exit(1), updater.state().phase === 'installing' ? 120_000 : 10_000).unref();
      try {
        removePairing(pairing);
      } catch (err) {
        log('pairing file: cannot remove it', err);
      }
      realtime.close();
      const closed = new Promise<void>((resolve) => server.close(() => resolve()));
      // Keep-alive connections would hold the server open
      server.closeAllConnections();
      // A download is aborted (its partial file deleted), an install is waited for
      closed.then(() => Promise.all([updater.stop(), uex.stop()])).then(() => close()).then(() => {
        unlock();
        console.log('stopped');
        process.exit(0);
      }, (err: unknown) => {
        console.error('shutdown failed', err);
        process.exit(1);
      });
    };
    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    // The shell cannot signal a child on Windows: a line "stop" on stdin is the same clean shutdown. A closed stdin means the
    // shell is gone, which stops the server too
    if (process.env.QM_STDIN_CONTROL === '1') {
      const lines = createInterface({ input: process.stdin });
      lines.on('line', (line) => {
        if (line.trim() === 'stop') shutdown('stop');
      });
      lines.on('close', () => shutdown('stdin closed'));
    }
  } catch (err) {
    await close().catch(() => {});
    unlock();
    throw err;
  }
}

main().catch((err: unknown) => {
  const code = err instanceof StartError ? err.code : 'internal';
  protocol(`QM_FATAL ${code}`);
  console.error(`Start failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
