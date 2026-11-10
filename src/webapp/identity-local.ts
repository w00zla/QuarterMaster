// The singleuser identity: one fixed user, whatever the database holds. No login, no sessions, no tokens: every
// request and every WebSocket is that user's. The local API is open to other programs on the machine on purpose
// (docs/singleuser.md "Identity"); what is kept out is web pages (acceptsWrite below).
import { sql } from 'drizzle-orm';
import type { Db } from '../db/client.ts';
import { sameOrigin, type Identity } from './identity.ts';
import { COMPANION_HEADER } from './companion.ts';
import type { Session } from './session.ts';

/**
 * The fixed user's id. User ids are Discord snowflakes kept as text, and both the schema (the CHECKs built by
 * `snowflake()` in src/db/schema/app.ts: app_user, history, user_privilege, feature_entry) and the code (SNOWFLAKE
 * in routes.ts) demand `^[0-9]{17,20}$`; me.ts reads it with BigInt(). Seventeen zeros satisfy all of that and can
 * never be a real user: Discord hands a snowflake out as the decimal form of a 64-bit number, which has no leading
 * zeros (and the number 0 itself is no snowflake). It also fits every integer type a consumer might parse it into.
 */
export const LOCAL_USER_ID = '00000000000000000';

const LOCAL_SESSION: Session = { userId: LOCAL_USER_ID, username: 'local', globalName: 'Local', avatar: null };

/**
 * Makes sure the user's app.app_user row exists (once, here: nothing in this variant deletes it) and returns the
 * identity. Call it outside a transaction, after the migrations.
 */
export async function localIdentity(db: Db): Promise<Identity> {
  await db.execute(sql`INSERT INTO app.app_user (user_id) VALUES (${LOCAL_USER_ID}) ON CONFLICT DO NOTHING`);

  return {
    // The API is open to local programs, but not to web pages: any page in the user's browser can send requests to
    // 127.0.0.1. A browser always sends `Origin` with a cross-origin write (and modern ones `Sec-Fetch-Site` with
    // every request), so a write is accepted when it is same-origin (the app's own SPA) or carries neither header
    // (not a browser: the companion, a script); a write that names another origin or site is a web page's and is
    // refused. `Authorization` earns nothing here: there are no tokens.
    acceptsWrite: (c, origin) => sameOrigin(c, origin)
      || (c.req.header('origin') === undefined && c.req.header('sec-fetch-site') === undefined),

    // No login: no /auth/* routes
    mountRoutes() {},

    async authenticate(c) {
      c.set('session', LOCAL_SESSION);
      // A label, not a security decision: the history says "companion" for a request that calls itself the
      // companion (any local program can say so; there is nothing to gain from it, the API is open anyway)
      if (c.req.header(COMPANION_HEADER) !== undefined) c.set('apiToken', true);
      return undefined;
    },

    // No accounts: no /api/token
    mountApiRoutes() {},

    authenticateDownload: async () => undefined,

    authenticateUpgrade: async () => ({ userId: LOCAL_USER_ID, valid: async () => true }),
  };
}
