// The online identity: Discord login (discord.ts), sessions in a __Host- cookie (session.ts) and the companion's
// API token (token.ts). Everything here is the public server's access control: docs/webapp.md "Login", "Sessions",
// "API token", "Security measures".
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { parse as parseCookies } from 'hono/utils/cookie';
import type { Context, MiddlewareHandler } from 'hono';
import type { Db } from '../db/client.ts';
import type { ApiTokenCreated, CompanionOutdated } from './api-types.ts';
import { COMPANION_HEADER, PLATFORMS, compareVersions, downloadPath } from './companion.ts';
import type { DiscordLogin } from './discord.ts';
import { sameOrigin, type Identity } from './identity.ts';
import type { Env } from './routes.ts';
import { ABSOLUTE_MS, SESSION_COOKIE, createSession, deleteSession, validateSession } from './session.ts';
import { apiTokenInfo, createApiToken, validateApiToken } from './token.ts';

const OAUTH_COOKIE = 'qm_oauth';
const OAUTH_MAX_AGE = 600;
const API_TOKEN = /^Bearer (qmt_[A-Za-z0-9_-]{43})$/;
const SESSION_COOKIE_NAME = `__Host-${SESSION_COOKIE}`;

// Where a login returns to (a deep link from the bot): a path of this app only, never `//host` or a
// backslash (no open redirect)
const RETURN_TO = /^\/(?![/\\])[A-Za-z0-9\-._~/?=&%]{0,500}$/;
const returnTarget = (value: string | undefined) => (value && RETURN_TO.test(value) ? value : '/');

const cookieOptions = (maxAge: number) =>
  ({ prefix: 'host', path: '/', secure: true, httpOnly: true, sameSite: 'Lax', maxAge }) as const;

export function discordIdentity(db: Db, login: DiscordLogin): Identity {
  const sessionToken = (c: Context) => getCookie(c, SESSION_COOKIE, 'host');

  return {
    // A write must come from our own origin. Hono's csrf() only looks at form content types,
    // and same-site is not enough (the admin UI on another port is the same site).
    // Not for the companion app: it sends no cookie but its API token, and a cross-site page cannot
    // set Authorization without a CORS preflight, which is never answered.
    acceptsWrite: (c, origin) => c.req.header('authorization') !== undefined || sameOrigin(c, origin),

    mountRoutes(app, { clientIp }) {
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
    },

    async authenticate(c, { origin, release }) {
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
            if (f) downloads[p] = `${origin}${downloadPath(f.file)}`;
          }
          return c.json({ error: 'companionOutdated', version: current.version, downloads } satisfies CompanionOutdated, 426);
        }
        const match = API_TOKEN.exec(auth);
        const session = match ? await validateApiToken(db, match[1]!) : null;
        if (!session) return c.json({ error: 'not logged in' }, 401);
        c.set('session', session);
        c.set('apiToken', true);
        return undefined;
      }
      const token = sessionToken(c);
      const session = token ? await validateSession(db, token) : null;
      if (!session) {
        if (token) deleteCookie(c, SESSION_COOKIE, { prefix: 'host', path: '/', secure: true });
        return c.json({ error: 'not logged in' }, 401);
      }
      c.set('session', session);
      c.set('token', token!);
      return undefined;
    },

    mountApiRoutes(api, { clientIp }) {
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
    },

    async authenticateDownload(c) {
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
      return undefined;
    },

    // The session cookie itself: the handshake runs outside Hono
    async authenticateUpgrade(req) {
      const token = parseCookies(req.headers.cookie ?? '', SESSION_COOKIE_NAME)[SESSION_COOKIE_NAME];
      if (!token) return null;
      const session = await validateSession(db, token);
      if (!session) return null;
      // Logout, expiry or a new login elsewhere ends the session
      return { userId: session.userId, valid: async () => (await validateSession(db, token)) !== null };
    },
  };
}
