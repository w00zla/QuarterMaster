// User web app process: Discord login, the JSON API and the built SPA (webapp/dist). Separate from
// the admin UI and the bot; shares code and database with them. Binds to 127.0.0.1 unless
// WEBAPP_HOST says otherwise; in production it sits behind Caddy (TLS).
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import { connect } from '../db/client.ts';
import { createApp } from './app.ts';
import { loadConfig, type ProcessConfig } from './config.ts';
import { discordLogin } from './discord.ts';
import { deleteExpiredSessions } from './session.ts';

let config: ProcessConfig;
try {
  config = loadConfig(process.env);
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}
const { origin } = config;

const { db, close } = connect(process.env.DATABASE_URL);
const login = discordLogin({ clientId: config.clientId, clientSecret: config.clientSecret, redirectUri: `${origin}/auth/callback` });
const app = createApp(db, login, {
  origin,
  trustProxy: config.trustProxy,
  distDir: fileURLToPath(new URL('../../webapp/dist', import.meta.url)),
});

const cleanup = () => deleteExpiredSessions(db).catch((err: unknown) => console.error('Session cleanup failed', err));
const cleanupTimer = setInterval(cleanup, 3600_000);
await cleanup();

const server = serve({ fetch: app.fetch, hostname: config.host, port: config.port }, (info) => {
  console.log(`User web app on http://${info.address}:${info.port} (public origin ${origin})`);
});

const shutdown = () => {
  clearInterval(cleanupTimer);
  server.close(() => void close().then(() => process.exit(0)));
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
