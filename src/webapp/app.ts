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
import { getMe } from './me.ts';
import {
  ABSOLUTE_MS, SESSION_COOKIE, createSession, deleteSession, hashToken, validateSession, type Session,
} from './session.ts';

export interface WebappConfig {
  // Where the browser sees the app, e.g. https://qm.example.com (no trailing slash)
  origin: string;
  // Behind Caddy: the client IP is the last X-Forwarded-For entry (Caddy drops the client's own)
  trustProxy: boolean;
  // Built SPA; null = none
  distDir: string | null;
  rateLimit?: { windowMs: number; auth: number; api: number };
}

type Env = { Variables: { session: Session; token: string } };

const OAUTH_COOKIE = 'qm_oauth';
const OAUTH_MAX_AGE = 600;
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const DEFAULT_LIMITS = { windowMs: 15 * 60_000, auth: 30, api: 1500 };

const cookieOptions = (maxAge: number) =>
  ({ prefix: 'host', path: '/', secure: true, httpOnly: true, sameSite: 'Lax', maxAge }) as const;

export function createApp(db: Db, login: DiscordLogin, config: WebappConfig) {
  const app = new Hono<Env>();
  const limits = config.rateLimit ?? DEFAULT_LIMITS;

  const clientIp = (c: Context) => {
    if (config.trustProxy) {
      const forwarded = c.req.header('x-forwarded-for')?.split(',').at(-1)?.trim();
      if (forwarded) return forwarded;
    }
    try {
      return getConnInfo(c).remote.address ?? 'unknown';
    } catch {
      // No Node socket (tests)
      return 'unknown';
    }
  };
  const sessionToken = (c: Context) => getCookie(c, SESSION_COOKIE, 'host');

  app.use('*', secureHeaders({
    contentSecurityPolicy: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'"],
      imgSrc: ["'self'", 'data:', 'https://cdn.discordapp.com'],
      fontSrc: ["'self'"],
      connectSrc: ["'self'"],
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

  app.use('/auth/*', rateLimiter({ windowMs: limits.windowMs, limit: limits.auth, keyGenerator: clientIp }));
  app.use('/api/*', rateLimiter({
    windowMs: limits.windowMs,
    limit: limits.api,
    keyGenerator: (c) => {
      const token = sessionToken(c);
      return token ? `s:${hashToken(token)}` : `ip:${clientIp(c)}`;
    },
  }));

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
    if (token) await deleteSession(db, token);
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

  api.notFound((c) => c.json({ error: 'not found' }, 404));
  app.route('/api', api);

  app.onError((err, c) => {
    console.error(err);
    return c.json({ error: 'internal error' }, 500);
  });

  // --- SPA --------------------------------------------------------------------------------
  if (config.distDir && existsSync(config.distDir)) {
    app.use('*', serveStatic({ root: config.distDir }));
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
