// Discord OAuth2 (authorization code + PKCE S256 + state) via openid-client. Discord is no OpenID
// provider: the endpoints are configured by hand and only the scope `identify` is requested. The
// access token is used once for /users/@me and then dropped; no Discord token is stored.
import * as client from 'openid-client';
import { z } from 'zod';

const API = 'https://discord.com/api/v10';

export interface DiscordUser {
  id: string;
  username: string;
  globalName: string | null;
  // Avatar hash, null = default avatar
  avatar: string | null;
}

export interface DiscordLogin {
  /** Fresh state and PKCE verifier plus the URL to send the browser to. */
  start(): Promise<{ url: URL; state: string; verifier: string }>;
  /** Checks the callback (state, PKCE) and returns the Discord user. Throws on anything unexpected. */
  finish(callbackQuery: string, state: string, verifier: string): Promise<DiscordUser>;
}

const userSchema = z.object({
  id: z.string().regex(/^[0-9]{17,20}$/),
  username: z.string(),
  global_name: z.string().nullish(),
  // Goes into a CDN URL: hash format only
  avatar: z.string().regex(/^(a_)?[0-9a-f]{32}$/).nullish(),
});

export function discordLogin(opts: {
  clientId: string;
  clientSecret: string;
  // e.g. http://localhost:5174/auth/callback; never derived from the request
  redirectUri: string;
  // Tests replace Discord's endpoints
  fetch?: typeof fetch;
}): DiscordLogin {
  const config = new client.Configuration({
    issuer: 'https://discord.com',
    authorization_endpoint: 'https://discord.com/oauth2/authorize',
    token_endpoint: `${API}/oauth2/token`,
  }, opts.clientId, opts.clientSecret);
  const doFetch = opts.fetch ?? fetch;
  if (opts.fetch) config[client.customFetch] = (url, options) => opts.fetch!(url, options as RequestInit);

  return {
    async start() {
      const state = client.randomState();
      const verifier = client.randomPKCECodeVerifier();
      const url = client.buildAuthorizationUrl(config, {
        redirect_uri: opts.redirectUri,
        scope: 'identify',
        state,
        code_challenge: await client.calculatePKCECodeChallenge(verifier),
        code_challenge_method: 'S256',
      });
      return { url, state, verifier };
    },
    async finish(callbackQuery, state, verifier) {
      const current = new URL(opts.redirectUri);
      current.search = callbackQuery;
      const tokens = await client.authorizationCodeGrant(config, current, { expectedState: state, pkceCodeVerifier: verifier });
      const res = await doFetch(`${API}/users/@me`, {
        headers: { authorization: `Bearer ${tokens.access_token}` },
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) throw new Error(`Discord /users/@me answered ${res.status}`);
      const user = userSchema.parse(await res.json());
      return { id: user.id, username: user.username, globalName: user.global_name ?? null, avatar: user.avatar ?? null };
    },
  };
}
