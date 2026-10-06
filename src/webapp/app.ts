// The user web app's HTTP layer (Hono): security headers, same-origin check for writes, rate limits,
// Discord login, sessions and the JSON API. Built by createApp so tests can drive it without a server.
// Plan and rationale: .claude/user-webapp-plan.md.
import { existsSync, readFileSync } from 'node:fs';
import { getConnInfo } from '@hono/node-server/conninfo';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono, type Context, type MiddlewareHandler } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { secureHeaders } from 'hono/secure-headers';
import { rateLimiter } from 'hono-rate-limiter';
import type { Db } from '../db/client.ts';
import type { DiscordLogin } from './discord.ts';
import { clientAddress, rateKey } from './ip.ts';
import { getMe } from './me.ts';
import {
  ABSOLUTE_MS, SESSION_COOKIE, createSession, deleteSession, validateSession, type Session,
} from './session.ts';

export interface WebappConfig {
  // Where the browser sees the app, e.g. https://qm.example.com (no trailing slash)
  origin: string;
  // Behind Caddy: the client IP is the last X-Forwarded-For entry (Caddy drops the client's own)
  trustProxy: boolean;
  // Built SPA; null = none
  distDir: string | null;
  // Per window: auth and apiIp per client address (IPv6 per /64), apiUser per logged-in user
  rateLimit?: { windowMs: number; auth: number; apiIp: number; apiUser: number };
}

type Env = { Variables: { session: Session; token: string } };

const OAUTH_COOKIE = 'qm_oauth';
const OAUTH_MAX_AGE = 600;
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const DEFAULT_LIMITS = { windowMs: 15 * 60_000, auth: 30, apiIp: 3000, apiUser: 1500 };
const IMMUTABLE = 'public, max-age=31536000, immutable';

const cookieOptions = (maxAge: number) =>
  ({ prefix: 'host', path: '/', secure: true, httpOnly: true, sameSite: 'Lax', maxAge }) as const;

export function createApp(db: Db, login: DiscordLogin, config: WebappConfig) {
  const app = new Hono<Env>();
  const limits = config.rateLimit ?? DEFAULT_LIMITS;

  const clientIp = (c: Context) => {
    let remote: string | undefined;
    try {
      remote = getConnInfo(c).remote.address;
    } catch {
      // No Node socket (tests)
    }
    return clientAddress(c.req.header('x-forwarded-for'), remote, config.trustProxy);
  };
  const sessionToken = (c: Context) => getCookie(c, SESSION_COOKIE, 'host');

  app.use('*', secureHeaders({
    contentSecurityPolicy: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'"],
      imgSrc: ["'self'", 'data:', 'https://cdn.discordapp.com'],
      fontSrc: ["'self'"],
      // The realtime WebSocket, explicitly: older browsers do not count ws(s) as 'self'
      connectSrc: ["'self'", config.origin.replace(/^http/, 'ws')],
      objectSrc: ["'none'"],
      baseUri: ["'none'"],
      formAction: ["'self'"],
      frameAncestors: ["'none'"],
    },
    // HSTS comes from Caddy (host-wide); Hono's default would add includeSubDomains
    strictTransportSecurity: false,
    // The callback URL carries the authorization code
    referrerPolicy: 'no-referrer',
    xFrameOptions: 'DENY',
    permissionsPolicy: { camera: [], microphone: [], geolocation: [] },
  }));

  // CSRF: a write must come from our own origin. Hono's csrf() only looks at form content types,
  // and same-site is not enough (the admin UI on another port is the same site).
  app.use('*', async (c, next) => {
    if (SAFE_METHODS.has(c.req.method)) return next();
    const site = c.req.header('sec-fetch-site');
    const ok = site !== undefined ? site === 'same-origin' : c.req.header('origin') === config.origin;
    if (!ok) return c.json({ error: 'cross-origin request refused' }, 403);
    return next();
  });

  const noStore: MiddlewareHandler = async (c, next) => {
    await next();
    c.header('Cache-Control', 'no-store');
  };
  app.use('/auth/*', noStore);
  app.use('/api/*', noStore);

  // Per address before anything touches the DB (random session cookies must not buy fresh
  // buckets); per user after the session check (see the API below)
  app.use('/auth/*', rateLimiter({ windowMs: limits.windowMs, limit: limits.auth, keyGenerator: (c) => rateKey(clientIp(c)) }));
  app.use('/api/*', rateLimiter({ windowMs: limits.windowMs, limit: limits.apiIp, keyGenerator: (c) => rateKey(clientIp(c)) }));

  // --- login ------------------------------------------------------------------------------
  app.get('/auth/login', async (c) => {
    const { url, state, verifier } = await login.start();
    setCookie(c, OAUTH_COOKIE, `${state}.${verifier}`, cookieOptions(OAUTH_MAX_AGE));
    return c.redirect(url.toString(), 302);
  });

  app.get('/auth/callback', async (c) => {
    const pending = getCookie(c, OAUTH_COOKIE, 'host');
    deleteCookie(c, OAUTH_COOKIE, { prefix: 'host', path: '/', secure: true });
    if (c.req.query('error')) return c.redirect('/?login=denied', 302);
    const [state, verifier] = pending?.split('.') ?? [];
    if (!state || !verifier) return c.redirect('/?login=failed', 302);
    let user;
    try {
      user = await login.finish(new URL(c.req.url).search, state, verifier);
    } catch (err) {
      // Wrong state, replayed or invalid code, Discord unreachable; never log the code
      console.warn(`Login failed (ip ${clientIp(c)}): ${err instanceof Error ? err.message : String(err)}`);
      return c.redirect('/?login=failed', 302);
    }
    // A new session on every login (no session fixation); an old one on this browser goes
    const old = sessionToken(c);
    if (old) await deleteSession(db, old);
    const token = await createSession(db, user);
    setCookie(c, SESSION_COOKIE, token, cookieOptions(ABSOLUTE_MS / 1000));
    console.log(`Login ${user.id} (ip ${clientIp(c)})`);
    return c.redirect('/', 302);
  });

  app.post('/auth/logout', async (c) => {
    const token = sessionToken(c);
    const userId = token ? await deleteSession(db, token) : null;
    if (userId) console.log(`Logout ${userId} (ip ${clientIp(c)})`);
    deleteCookie(c, SESSION_COOKIE, { prefix: 'host', path: '/', secure: true });
    return c.body(null, 204);
  });

  // --- API --------------------------------------------------------------------------------
  const api = new Hono<Env>();
  api.use('*', async (c, next) => {
    const token = sessionToken(c);
    const session = token ? await validateSession(db, token) : null;
    if (!session) {
      if (token) deleteCookie(c, SESSION_COOKIE, { prefix: 'host', path: '/', secure: true });
      return c.json({ error: 'not logged in' }, 401);
    }
    c.set('session', session);
    c.set('token', token!);
    return next();
  });
  api.use('*', rateLimiter<Env>({ windowMs: limits.windowMs, limit: limits.apiUser, keyGenerator: (c) => `u:${c.get('session').userId}` }));
  // Writes take JSON only: a cross-site JSON request needs a CORS preflight, which is never answered
  api.use('*', async (c, next) => {
    if (SAFE_METHODS.has(c.req.method)) return next();
    if (c.req.header('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json') {
      return c.json({ error: 'JSON only' }, 415);
    }
    return next();
  });
  api.use('*', bodyLimit({ maxSize: 16 * 1024, onError: (c) => c.json({ error: 'request too large' }, 413) }));

  api.get('/me', async (c) => c.json(await getMe(db, c.get('session'))));

  // Last: a sub-app's notFound does not apply once mounted, and the SPA fallback must never answer /api
  api.all('*', (c) => c.json({ error: 'not found' }, 404));
  app.route('/api', api);

  app.onError((err, c) => {
    console.error(err);
    return c.json({ error: 'internal error' }, 500);
  });

  // --- SPA --------------------------------------------------------------------------------
  if (config.distDir && existsSync(config.distDir)) {
    const files = serveStatic({ root: config.distDir });
    // Hashed file names: cache for good
    app.use('/assets/*', async (c, next) => {
      await next();
      if (c.res.ok) c.header('Cache-Control', IMMUTABLE);
    });
    // No dotfiles; index.html always through the fallback below (no-cache)
    app.use('*', (c, next) => {
      const path = c.req.path;
      return path === '/' || path === '/index.html' || path.split('/').some((s) => s.startsWith('.')) ? next() : files(c, next);
    });
    const index = readFileSync(`${config.distDir}/index.html`, 'utf8');
    app.get('*', (c) => {
      c.header('Cache-Control', 'no-cache');
      return c.html(index);
    });
  } else {
    app.get('*', (c) => c.text('SPA not built.', 404));
  }

  return app;
}
