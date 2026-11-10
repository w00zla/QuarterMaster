// User web app process: Discord login, the JSON API and the built SPA (webapp/dist). Separate from
// the admin UI and the bot; shares code and database with them. Binds to 127.0.0.1 unless
// WEBAPP_HOST says otherwise; in production it sits behind Caddy (TLS).
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import { connect } from '../db/client.ts';
import { createApp } from './app.ts';
import { loadConfig, type ProcessConfig } from './config.ts';
import { discordLogin } from './discord.ts';
import { discordIdentity } from './identity-discord.ts';
import { RealtimeHub, listenForChanges } from './realtime.ts';
import { deleteExpiredSessions } from './session.ts';

let config: ProcessConfig;
try {
  config = loadConfig(process.env);
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}
const { origin } = config;

const { db, close, client } = connect(process.env.DATABASE_URL);
const login = discordLogin({ clientId: config.clientId, clientSecret: config.clientSecret, redirectUri: `${origin}/auth/callback` });
// The online variant: Discord login, sessions and API tokens; orgs and UEX trading
const identity = discordIdentity(db, login);
const app = createApp(db, identity, {
  origin,
  trustProxy: config.trustProxy,
  distDir: fileURLToPath(new URL('../../webapp/dist', import.meta.url)),
  companionDir: config.companionDir,
  thumbsDir: config.thumbsDir,
  capabilities: { login: 'discord', orgs: true, uex: true },
});

const cleanup = () => deleteExpiredSessions(db).catch((err: unknown) => console.error('Session cleanup failed', err));
const cleanupTimer = setInterval(cleanup, 3600_000);
await cleanup();

const log = (message: string, err?: unknown) => (err === undefined ? console.log(message) : console.error(message, err));
const realtime = new RealtimeHub(db, identity, { origin, trustProxy: config.trustProxy }, log);
await listenForChanges(client, realtime, log);

const server = serve({ fetch: app.fetch, hostname: config.host, port: config.port }, (info) => {
  console.log(`User web app on http://${info.address}:${info.port} (public origin ${origin})`);
});
// WebSocket handshakes bypass Hono (realtime.ts checks them itself)
server.on('upgrade', (req, socket, head) => realtime.handleUpgrade(req, socket, head));

const shutdown = () => {
  clearInterval(cleanupTimer);
  // Open sockets would keep the server from closing
  realtime.close();
  server.close(() => void close().then(() => process.exit(0)));
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
