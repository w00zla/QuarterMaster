// The user's orgs from /api/me and their member lists (GET /api/orgs/:g/members), cached per org and
// reloaded on 'members' (that org), 'profile' (an RSI handle) and 'resync'.
import { reactive } from "vue";
import type { MeOrg, OrgMember } from "../../src/webapp/api-types";
import { api } from "./api";
import { lang } from "./i18n";
import { onServerMessage } from "./realtime";
import { me } from "./session";

/** Org stock can be changed only while the bot vouches for the roster (the server refuses otherwise). */
export const writable = (o: MeOrg | undefined) => !!o && o.rosterFresh && o.botPresent;

export const orgOf = (guildId: string | null | undefined) => me.value?.orgs.find((o) => o.guildId === guildId);

export const members = reactive<Record<string, OrgMember[] | undefined>>({});
const loading = new Set<string>();
// Reload requests that came in during a load: one more load after it (the running one may be older)
const again = new Set<string>();

async function fetchMembers(guildId: string) {
  if (loading.has(guildId)) {
    again.add(guildId);
    return;
  }
  loading.add(guildId);
  try {
    do {
      again.delete(guildId);
      try {
        // The contract names the item type only; take a bare array or a { members } wrapper
        const r = await api<OrgMember[] | { members: OrgMember[] }>(`/orgs/${encodeURIComponent(guildId)}/members`);
        const list = Array.isArray(r) ? r : r.members;
        members[guildId] = [...list].sort((a, b) => a.displayName.localeCompare(b.displayName, lang.value));
      } catch {
        // Not a member (anymore) or offline: the pickers stay empty
        members[guildId] = members[guildId] ?? [];
      }
    } while (again.has(guildId));
  } finally {
    loading.delete(guildId);
  }
}

/** Starts loading an org's members once; read them from `members[guildId]`. */
export function ensureMembers(guildId: string) {
  if (!(guildId in members)) void fetchMembers(guildId);
}

onServerMessage((m) => {
  const loaded = Object.keys(members);
  if (m.type === "members" && loaded.includes(m.guildId)) void fetchMembers(m.guildId);
  else if (m.type === "profile" || m.type === "resync") for (const g of loaded) void fetchMembers(g);
});

/** "Name (RSI handle)" where a handle is set. */
export const memberLabel = (m: { displayName: string; rsiHandle: string | null }) =>
  m.rsiHandle ? `${m.displayName} (${m.rsiHandle})` : m.displayName;

export const memberOptions = (guildId: string) =>
  (members[guildId] ?? []).map((m) => ({ value: m.userId, label: memberLabel(m) }));
