// User web app process: Discord login, the JSON API and the built SPA (webapp/dist). Separate from
// the admin UI and the bot; shares code and database with them. Binds to 127.0.0.1 unless
// WEBAPP_HOST says otherwise; in production it sits behind Caddy (TLS).
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import { connect } from '../db/client.ts';
import { createApp } from './app.ts';
import { discordLogin } from './discord.ts';
import { deleteExpiredSessions } from './session.ts';

const {
  DISCORD_APP_ID, DISCORD_CLIENT_SECRET, WEBAPP_ORIGIN,
  WEBAPP_HOST = '127.0.0.1', WEBAPP_PORT = '3002', WEBAPP_TRUST_PROXY,
} = process.env;
if (!DISCORD_APP_ID || !DISCORD_CLIENT_SECRET || !WEBAPP_ORIGIN) {
  console.error('DISCORD_APP_ID, DISCORD_CLIENT_SECRET and WEBAPP_ORIGIN must be set (see .env.example)');
  process.exit(1);
}
const origin = new URL(WEBAPP_ORIGIN).origin;
const local = ['localhost', '127.0.0.1', '[::1]'].includes(new URL(origin).hostname);
if (!origin.startsWith('https://') && !local) {
  console.error('WEBAPP_ORIGIN must be https:// (plain http only for localhost)');
  process.exit(1);
}

const { db, close } = connect(process.env.DATABASE_URL);
const login = discordLogin({ clientId: DISCORD_APP_ID, clientSecret: DISCORD_CLIENT_SECRET, redirectUri: `${origin}/auth/callback` });
const app = createApp(db, login, {
  origin,
  trustProxy: WEBAPP_TRUST_PROXY === '1',
  distDir: fileURLToPath(new URL('../../webapp/dist', import.meta.url)),
});

const cleanup = () => deleteExpiredSessions(db).catch((err: unknown) => console.error('Session cleanup failed', err));
const cleanupTimer = setInterval(cleanup, 3600_000);
await cleanup();

const server = serve({ fetch: app.fetch, hostname: WEBAPP_HOST, port: Number(WEBAPP_PORT) }, (info) => {
  console.log(`User web app on http://${info.address}:${info.port} (public origin ${origin})`);
});

const shutdown = () => {
  clearInterval(cleanupTimer);
  server.close(() => void close().then(() => process.exit(0)));
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
