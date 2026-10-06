// Response types of the user web app API, shared with its SPA. Pure types: no server imports.

export interface MeOrg {
  guildId: string;
  name: string;
  // The user's name on that server (roster)
  displayName: string;
  officer: boolean;
  // False while the bot cannot vouch for this org's roster: its org stock is read-only then
  rosterFresh: boolean;
  // How long it stays fresh without a new beat (0 when stale): the SPA asks again then, since the
  // bot's minute beat itself is not announced (only fresh <-> stale changes made in the DB are)
  rosterFreshForMs: number;
  // False once the bot was removed from the server (the roster is frozen, so never fresh)
  botPresent: boolean;
}

export interface MeResponse {
  userId: string;
  // Discord display name (global name, else username) and username, as of the last login
  name: string;
  username: string;
  avatarUrl: string;
  // Active memberships only
  orgs: MeOrg[];
}

// --- realtime (WebSocket /api/ws) ------------------------------------------------------------
// The server only says what changed; the SPA fetches it through the normal endpoints.

export type ServerMessage =
  // Your orgs, roles or an org's state (name, roster freshness, bot presence) changed: reload /api/me
  | { type: 'me' }
  // An org's member list changed
  | { type: 'members'; guildId: string }
  // Stock changed: your personal stock, or an org's
  | { type: 'stock'; scope: 'personal' }
  | { type: 'stock'; scope: 'org'; guildId: string }
  // Blueprints or profile (RSI handle) of you or someone in your orgs changed
  | { type: 'blueprints'; userId: string }
  | { type: 'profile'; userId: string }
  // Changes may have been missed (the server lost its DB listener): reload everything
  | { type: 'resync' }
  | { type: 'pong' };

export type ClientMessage = { type: 'ping' };
