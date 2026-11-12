// Process settings from the environment, checked before anything starts.
import { fileURLToPath } from 'node:url';
export interface ProcessConfig {
  clientId: string;
  clientSecret: string;
  // Where the browser sees the app, normalized (no path, no trailing slash)
  origin: string;
  host: string;
  port: number;
  trustProxy: boolean;
  // The item thumbnails (s/, m/, l/ and thumbs.json, tools/thumbs)
  thumbsDir: string;
}

/** Throws with a message for the operator when a setting is missing or unsafe. */
export function loadConfig(env: Record<string, string | undefined>): ProcessConfig {
  const { DISCORD_APP_ID, DISCORD_CLIENT_SECRET, WEBAPP_ORIGIN, WEBAPP_HOST = '127.0.0.1', WEBAPP_PORT = '3002', WEBAPP_TRUST_PROXY } = env;
  const { THUMBS_DIR = fileURLToPath(new URL('../../local/thumbs', import.meta.url)) } = env;
  if (!DISCORD_APP_ID || !DISCORD_CLIENT_SECRET || !WEBAPP_ORIGIN) {
    throw new Error('DISCORD_APP_ID, DISCORD_CLIENT_SECRET and WEBAPP_ORIGIN must be set (see .env.example)');
  }
  const origin = new URL(WEBAPP_ORIGIN).origin;
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(new URL(origin).hostname);
  if (!origin.startsWith('https://') && !local) throw new Error('WEBAPP_ORIGIN must be https:// (plain http only for localhost)');
  if (![undefined, '', '0', '1'].includes(WEBAPP_TRUST_PROXY)) throw new Error('WEBAPP_TRUST_PROXY must be 1, 0 or empty');
  // A public origin means a TLS proxy in front: without trusting its X-Forwarded-For every client
  // shares one rate limit bucket, and one client can lock everyone out of the login
  if (!local && !WEBAPP_TRUST_PROXY) {
    throw new Error('WEBAPP_TRUST_PROXY must be set for a public origin: 1 behind Caddy, 0 only if the app sees clients directly');
  }
  return {
    clientId: DISCORD_APP_ID,
    clientSecret: DISCORD_CLIENT_SECRET,
    origin,
    host: WEBAPP_HOST,
    port: Number(WEBAPP_PORT),
    trustProxy: WEBAPP_TRUST_PROXY === '1',
    thumbsDir: THUMBS_DIR,
  };
}
