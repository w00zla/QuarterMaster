// The user web app's HTTP layer (Hono): security headers, the origin check for writes, rate limits and the
// JSON API. Who the user is (login, sessions, tokens, or one fixed user) is the Identity's, passed in.
// Built by createApp so tests can drive it without a server. Design and rationale: docs/webapp.md.
import { createReadStream, existsSync, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { getConnInfo } from '@hono/node-server/conninfo';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono, type Context, type MiddlewareHandler } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { secureHeaders } from 'hono/secure-headers';
import { rateLimiter } from 'hono-rate-limiter';
import type { Db } from '../db/client.ts';
import type { Capabilities, CompanionInfo } from './api-types.ts';
import { PLATFORMS, UPDATE_FEED, companionRelease, downloadPath, updateFeed } from './companion.ts';
import { BLOB_BODY_LIMIT, BLOB_ROUTE } from './features.ts';
import type { Identity, IdentityHost } from './identity.ts';
import { clientAddress, rateKey } from './ip.ts';
import { getMe } from './me.ts';
import { HttpError, registerRoutes } from './routes.ts';
import type { Session } from './session.ts';
import { thumbIndex } from '../thumbs-index.ts';
import { THUMB_FILE, THUMB_SIZES } from '../thumbs.ts';

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
  // What this server offers (GET /api/capabilities); `orgs` also decides whether the org routes exist
  capabilities: Capabilities;
  // The Host header values a request may carry (e.g. 127.0.0.1:28460), lower case; any other request is refused (421).
  // Against DNS rebinding: a page whose domain was re-pointed to this machine is same-origin to the browser. A host of
  // the list that is not the origin's own is sent to the origin (GET pages only). Unset = no check (online: Caddy
  // matches the host).
  allowedHosts?: string[];
  // Routes only one variant has (singleuser: the data update): called with the API router after the regular routes and
  // the identity's, before the 404 catch-all. Online passes none.
  mountApi?: (api: ApiApp) => void;
}

// apiToken: the request authenticated with the user's API token (companion app), not a session
type Env = { Variables: { session: Session; token: string; apiToken?: boolean } };
/** The API router (everything under /api, after the identity check and the JSON-only rule for writes). */
export type ApiApp = Hono<Env>;

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const DEFAULT_LIMITS = { windowMs: 15 * 60_000, auth: 30, apiIp: 3000, apiUser: 1500 };
// Paths of API clients, which work on any allowed host
const NOT_A_PAGE = /^\/(api|auth|thumbs|downloads)(\/|$)/;
const IMMUTABLE = 'public, max-age=31536000, immutable';

export function createApp(db: Db, identity: Identity, config: WebappConfig) {
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
  const release = companionRelease(config.companionDir ?? null);
  const thumbs = thumbIndex(config.thumbsDir ?? null);
  const host: IdentityHost = { origin: config.origin, clientIp, release };

  // First of all: a request for a host that is not ours is nobody's business (DNS rebinding)
  if (config.allowedHosts) {
    const allowed = new Set(config.allowedHosts);
    const canonicalHost = new URL(config.origin).host;
    app.use('*', async (c, next) => {
      const requested = c.req.header('host')?.toLowerCase();
      if (requested === undefined || !allowed.has(requested)) return c.json({ error: 'host not allowed' }, 421);
      // Another name of this machine: the SPA must run on the origin the WebSocket and CSRF checks expect
      if (requested !== canonicalHost && (c.req.method === 'GET' || c.req.method === 'HEAD') && !NOT_A_PAGE.test(c.req.path)) {
        const url = new URL(c.req.url);
        return c.redirect(`${config.origin}${url.pathname}${url.search}`, 307);
      }
      return next();
    });
  }

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

  // CSRF: which writes may come in is the identity's rule (online: our own origin or the companion's token)
  app.use('*', async (c, next) => {
    if (SAFE_METHODS.has(c.req.method) || identity.acceptsWrite(c, config.origin)) return next();
    return c.json({ error: 'cross-origin request refused' }, 403);
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

  // --- the identity's own routes (online: the login, /auth/*) ------------------------------
  identity.mountRoutes(app, host);

  // What this server offers: before the user check (the SPA asks before it has a session)
  app.get('/api/capabilities', (c) => c.json(config.capabilities satisfies Capabilities));

  // --- API --------------------------------------------------------------------------------
  const api = new Hono<Env>();
  api.use('*', async (c, next) => (await identity.authenticate(c, host)) ?? next());
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
  registerRoutes(api, db, thumbs, { orgs: config.capabilities.orgs });

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

  // The routes that only exist with accounts (online: the API token)
  identity.mountApiRoutes(api, host);
  config.mountApi?.(api);

  // Last: a sub-app's notFound does not apply once mounted, and the SPA fallback must never answer /api
  api.all('*', (c) => c.json({ error: 'not found' }, 404));
  app.route('/api', api);

  app.onError((err, c) => {
    if (err instanceof HttpError) return c.json({ error: err.message }, err.status);
    console.error(err);
    return c.json({ error: 'internal error' }, 500);
  });

  // --- companion app downloads (who may: the identity; only the files the manifest names) ---
  app.use('/downloads/*', rateLimiter({ windowMs: limits.windowMs, limit: limits.auth, keyGenerator: (c) => rateKey(clientIp(c)) }));
  app.use('/downloads/companion/*', async (c, next) => (await identity.authenticateDownload(c)) ?? next());
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
