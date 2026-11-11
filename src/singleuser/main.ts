// The singleuser variant: one local process serving the web app and its API on PGlite for one fixed user (the local
// identity). Binds to 127.0.0.1 only. One process per data folder (PGlite has no second opener): docs/singleuser.md.
import { mkdirSync } from 'node:fs';
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
import { dataDir, dbDir, thumbsDir } from './paths.ts';
import { pairingFile, removePairing, writePairing } from './pairing.ts';
import { choosePort } from './port.ts';
import { createSettingsStore, settingsFile } from './settings.ts';
import { mountSettingsRoutes, type LoadedPack } from './settings-routes.ts';

const HOST = '127.0.0.1';

/** One compact line per loading step, with its duration. */
async function step<T>(name: string, run: () => Promise<T>): Promise<T> {
  const start = performance.now();
  const result = await run();
  console.log(`${name}: ${Math.round(performance.now() - start)} ms`);
  return result;
}

const log = (message: string, err?: unknown) => (err === undefined ? console.log(message) : console.error(message, err));

async function main() {
  const started = performance.now();
  const data = dataDir(process.env, process.platform, homedir());
  mkdirSync(data, { recursive: true });
  // Before the database is touched: a taken port must not cost an open
  const port = await choosePort(process.env);
  const origin = `http://${HOST}:${port}`;
  console.log(`data folder: ${data}`);

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
    await step('open database', () => db.execute(sql`SELECT 1`));
    await step('migrations', () => migrate(fileURLToPath(new URL('../../drizzle', import.meta.url))));
    await step('checkpoint', () => db.execute(sql`CHECKPOINT`));
    // The language pack: stored as a source above the game's English, before any request is answered
    await syncLanguagePack(connection, pack, log);
    languagePack.active = pack?.texts != null;
    const identity = await localIdentity(db);

    // The data update: the only thing in this process that uses the network (the GitHub feed, or QM_DATA_FEED: a folder)
    const feed = process.env.QM_DATA_FEED ? folderFeed(process.env.QM_DATA_FEED) : githubFeed({ fetch });
    const updater = createDataUpdater({ connection, dataDir: data, thumbsDir: join(data, 'thumbs'), feed, log: (m) => log(m) });

    // The Host guard (DNS rebinding): only the names of this machine, with the port
    const allowedHosts = [`127.0.0.1:${port}`, `localhost:${port}`];
    const app = createApp(db, identity, {
      origin,
      trustProxy: false,
      distDir: fileURLToPath(new URL('../../webapp/dist', import.meta.url)),
      thumbsDir: thumbsDir(process.env, data),
      capabilities: { login: 'none', orgs: false, uex: false },
      // One local user: the limits must never bite (the mechanism stays)
      rateLimit: { windowMs: 60_000, auth: 100_000, apiIp: 100_000, apiUser: 100_000 },
      allowedHosts,
      mountApi: (api) => {
        mountDataRoutes(updater)(api);
        mountSettingsRoutes({
          store: settings,
          loaded: languagePack,
          onGameDirChange: (dir) => writePairingFile(origin, dir),
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

    const server = serve({ fetch: app.fetch, hostname: HOST, port }) as Server;
    // WebSocket handshakes bypass Hono (realtime.ts checks them itself)
    server.on('upgrade', (req, socket, head) => realtime.handleUpgrade(req, socket, head));
    await step('listen', () => new Promise<void>((resolve, reject) => {
      server.once('listening', resolve);
      server.once('error', reject);
    }));
    console.log(`listening on ${origin} (started in ${Math.round(performance.now() - started)} ms)`);
    writePairingFile(origin, gameDir);
    // In the background: the start never waits for the network
    if (autoUpdate) void updater.check();
    else console.log('automatic update: off');

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
      closed.then(() => updater.stop()).then(() => close()).then(() => {
        console.log('stopped');
        process.exit(0);
      }, (err: unknown) => {
        console.error('shutdown failed', err);
        process.exit(1);
      });
    };
    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));
  } catch (err) {
    await close().catch(() => {});
    throw err;
  }
}

main().catch((err: unknown) => {
  console.error(`Start failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
