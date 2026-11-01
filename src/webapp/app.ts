// The user web app's HTTP layer (Hono): security headers, same-origin check for writes, rate limits,
// Discord login, sessions and the JSON API. Built by createApp so tests can drive it without a server.
// Design and rationale: docs/webapp.md.
import { createReadStream, existsSync, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { getConnInfo } from '@hono/node-server/conninfo';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono, type Context, type MiddlewareHandler } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { secureHeaders } from 'hono/secure-headers';
import { rateLimiter } from 'hono-rate-limiter';
import type { Db } from '../db/client.ts';
import type { ApiTokenCreated, CompanionInfo, CompanionOutdated } from './api-types.ts';
import { COMPANION_HEADER, PLATFORMS, UPDATE_FEED, companionRelease, compareVersions, downloadPath, updateFeed } from './companion.ts';
import type { DiscordLogin } from './discord.ts';
import { BLOB_BODY_LIMIT, BLOB_ROUTE } from './features.ts';
import { clientAddress, rateKey } from './ip.ts';
import { getMe } from './me.ts';
import { HttpError, registerRoutes } from './routes.ts';
import {
  ABSOLUTE_MS, SESSION_COOKIE, createSession, deleteSession, validateSession, type Session,
} from './session.ts';
import { thumbIndex } from './thumbs.ts';
import { THUMB_FILE, THUMB_SIZES } from '../thumbs.ts';
import { apiTokenInfo, createApiToken, validateApiToken } from './token.ts';

export interface WebappConfig {
  // Where the browser sees the app, e.g. https://qm.example.com (no trailing slash)
  origin: string;
  // Behind Caddy: the client IP is the last X-Forwarded-For entry (Caddy drops the client's own)
  trustProxy: boolean;
  // Built SPA; null = none
  distDir: string | null;
  // Companion app release (companion.json + files, see companion.ts); null/missing = none
  companionDir?: string | null;
  // Item thumbnails (s/, m/, l/ and thumbs.json, see thumbs.ts); null/missing = none
  thumbsDir?: string | null;
  // Per window: auth and apiIp per client address (IPv6 per /64), apiUser per logged-in user
  rateLimit?: { windowMs: number; auth: number; apiIp: number; apiUser: number };
}

// apiToken: the request authenticated with the user's API token (companion app), not a session
type Env = { Variables: { session: Session; token: string; apiToken?: boolean } };

const OAUTH_COOKIE = 'qm_oauth';
const OAUTH_MAX_AGE = 600;
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const DEFAULT_LIMITS = { windowMs: 15 * 60_000, auth: 30, apiIp: 3000, apiUser: 1500 };
const IMMUTABLE = 'public, max-age=31536000, immutable';
const API_TOKEN = /^Bearer (qmt_[A-Za-z0-9_-]{43})$/;

// Where a login returns to (a deep link from the bot): a path of this app only, never `//host` or a
// backslash (no open redirect)
const RETURN_TO = /^\/(?![/\\])[A-Za-z0-9\-._~/?=&%]{0,500}$/;
const returnTarget = (value: string | undefined) => (value && RETURN_TO.test(value) ? value : '/');

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
  const release = companionRelease(config.companionDir ?? null);
  const thumbs = thumbIndex(config.thumbsDir ?? null);

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
  // Not for the companion app: it sends no cookie but its API token, and a cross-site page cannot
  // set Authorization without a CORS preflight, which is never answered.
  app.use('*', async (c, next) => {
    if (SAFE_METHODS.has(c.req.method) || c.req.header('authorization') !== undefined) return next();
    const site = c.req.header('sec-fetch-site');
    const ok = site !== undefined ? site === 'same-origin' : c.req.header('origin') === config.origin;
    if (!ok) return c.json({ error: 'cross-origin request refused' }, 403);
    return next();
  });

  // Unless the route sets its own (the catalog: revalidated by its ETag)
  const noStore: MiddlewareHandler = async (c, next) => {
    await next();
    if (!c.res.headers.has('Cache-Control')) c.header('Cache-Control', 'no-store');
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
    const returnTo = Buffer.from(returnTarget(c.req.query('returnTo'))).toString('base64url');
    setCookie(c, OAUTH_COOKIE, `${state}.${verifier}.${returnTo}`, cookieOptions(OAUTH_MAX_AGE));
    return c.redirect(url.toString(), 302);
  });

  app.get('/auth/callback', async (c) => {
    const pending = getCookie(c, OAUTH_COOKIE, 'host');
    deleteCookie(c, OAUTH_COOKIE, { prefix: 'host', path: '/', secure: true });
    if (c.req.query('error')) return c.redirect('/?login=denied', 302);
    const [state, verifier, returnTo] = pending?.split('.') ?? [];
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
    return c.redirect(returnTarget(returnTo && Buffer.from(returnTo, 'base64url').toString()), 302);
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
    // Companion app: its API token, never a cookie
    const auth = c.req.header('authorization');
    if (auth !== undefined) {
      // An outdated app does no work: it gets the new version's links instead (also before its token is checked)
      const current = release();
      const version = c.req.header(COMPANION_HEADER) ?? '';
      if (current && compareVersions(version, current.version) < 0) {
        const downloads: CompanionOutdated['downloads'] = {};
        for (const p of PLATFORMS) {
          const f = current.files[p];
          if (f) downloads[p] = `${config.origin}${downloadPath(f.file)}`;
        }
        return c.json({ error: 'companionOutdated', version: current.version, downloads } satisfies CompanionOutdated, 426);
      }
      const match = API_TOKEN.exec(auth);
      const session = match ? await validateApiToken(db, match[1]!) : null;
      if (!session) return c.json({ error: 'not logged in' }, 401);
      c.set('session', session);
      c.set('apiToken', true);
      return next();
    }
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
  // A feature's image upload (base64 in JSON) gets its own limit
  const tooLarge = (c: Context) => c.json({ error: 'request too large' }, 413);
  const smallBody = bodyLimit({ maxSize: 16 * 1024, onError: tooLarge });
  const blobBody = bodyLimit({ maxSize: BLOB_BODY_LIMIT, onError: tooLarge });
  api.use('*', (c, next) => (BLOB_ROUTE.test(c.req.path) ? blobBody : smallBody)(c, next));

  api.get('/me', async (c) => c.json(await getMe(db, c.get('session'))));
  registerRoutes(api, db, thumbs);

  api.get('/companion', (c) => {
    const current = release();
    // The setup first (the Windows app for good, it updates itself), then the standalone builds
    const setup = current?.setup;
    const downloads: CompanionInfo['downloads'] = setup
      ? [{ platform: 'windows', kind: 'setup', file: setup.file, size: setup.size, url: downloadPath(setup.file) }]
      : [];
    if (current) {
      for (const platform of PLATFORMS) {
        const f = current.files[platform];
        if (f) downloads.push({ platform, kind: 'standalone', file: f.file, size: f.size, url: downloadPath(f.file) });
      }
    }
    return c.json({ version: current?.version ?? null, downloads } satisfies CompanionInfo);
  });

  // The API token itself: session only (a token must not mint tokens)
  const sessionOnly: MiddlewareHandler<Env> = async (c, next) => {
    if (c.get('apiToken')) return c.json({ error: 'sessionOnly' }, 403);
    return next();
  };
  api.get('/token', sessionOnly, async (c) => c.json(await apiTokenInfo(db, c.get('session').userId)));
  api.post('/token', sessionOnly, async (c) => {
    const token = await createApiToken(db, c.get('session'));
    console.log(`API token created by ${c.get('session').userId} (ip ${clientIp(c)})`);
    return c.json({ token } satisfies ApiTokenCreated);
  });

  // Last: a sub-app's notFound does not apply once mounted, and the SPA fallback must never answer /api
  api.all('*', (c) => c.json({ error: 'not found' }, 404));
  app.route('/api', api);

  app.onError((err, c) => {
    if (err instanceof HttpError) return c.json({ error: err.message }, err.status);
    console.error(err);
    return c.json({ error: 'internal error' }, 500);
  });

  // --- companion app downloads (logged in or the companion's API token; only the files the manifest names) ---
  app.use('/downloads/*', rateLimiter({ windowMs: limits.windowMs, limit: limits.auth, keyGenerator: (c) => rateKey(clientIp(c)) }));
  app.use('/downloads/companion/*', async (c, next) => {
    // The companion app downloads its update itself, with its token (no version check here: an
    // outdated app is exactly the one that needs the file)
    const auth = c.req.header('authorization');
    if (auth !== undefined) {
      const match = API_TOKEN.exec(auth);
      if (!match || !await validateApiToken(db, match[1]!)) return c.json({ error: 'not logged in' }, 401);
    } else {
      const token = sessionToken(c);
      if (!token || !await validateSession(db, token)) return c.redirect('/', 302);
    }
    return next();
  });
  // The installed app's updater reads the setup's URL and signature here
  app.get(`/downloads/companion/${UPDATE_FEED}`, (c) => {
    const feed = updateFeed(release(), config.origin);
    c.header('Cache-Control', 'no-store');
    return feed ? c.json(feed) : c.json({ error: 'not found' }, 404);
  });
  app.get('/downloads/companion/:file', async (c) => {
    const current = release();
    const file = c.req.param('file');
    const entry = current && [...PLATFORMS.map((p) => current.files[p]), current.setup].find((f) => f?.file === file);
    if (!entry || !config.companionDir) return c.text('Not found', 404);
    c.header('Content-Type', 'application/octet-stream');
    c.header('Content-Length', String(entry.size));
    c.header('Content-Disposition', `attachment; filename="${entry.file.replace(/"/g, '')}"`);
    c.header('Cache-Control', 'no-store');
    return c.body(Readable.toWeb(createReadStream(join(config.companionDir, entry.file))) as ReadableStream);
  });

  // --- item thumbnails (public, no login: game renders like the wiki's; the name carries a content hash) ---
  app.get('/thumbs/:size/:file', async (c) => {
    const size = c.req.param('size');
    const file = c.req.param('file');
    const m = THUMB_FILE.exec(file);
    if (!config.thumbsDir || !Object.hasOwn(THUMB_SIZES, size) || !m || thumbs().get(m[1]!) !== m[2]) return c.text('Not found', 404);
    let body: Buffer;
    try {
      body = await readFile(join(config.thumbsDir, size, file));
    } catch {
      return c.text('Not found', 404);
    }
    c.header('Content-Type', 'image/avif');
    c.header('Cache-Control', IMMUTABLE);
    return c.body(new Uint8Array(body));
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
