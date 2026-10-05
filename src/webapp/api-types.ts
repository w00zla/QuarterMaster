// Response types of the user web app API, shared with its SPA. Pure types: no server imports.

export interface MeOrg {
  guildId: string;
  name: string;
  // The user's name on that server (roster)
  displayName: string;
  officer: boolean;
}

export interface MeResponse {
  userId: string;
  // Discord display name (global name, else username) and username, as of the last login
  name: string;
  username: string;
  avatarUrl: string;
  // Active memberships only
  orgs: MeOrg[];
  // False when the bot's roster sync is not alive: org stock is read-only then
  rosterFresh: boolean;
}
