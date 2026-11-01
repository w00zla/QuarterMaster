<script setup lang="ts">
// Every known user (app_user, web logins, companion tokens) with a rough look at their data; read-only except
// their privileges (section Privileges: assign, take back).
import { computed, ref } from "vue";
import { RouterLink, useRoute, useRouter } from "vue-router";
import DataTable from "../components/DataTable.vue";
import DetailPanel from "../components/DetailPanel.vue";
import Icon from "../components/Icon.vue";
import StockTotals from "../components/StockTotals.vue";
import Tooltip from "../components/Tooltip.vue";
import { send, useFetch } from "../api";
import { dateTime, matches } from "../format";
import { useStoredTab } from "../storedTab";
import type { ActivitySource, UserDetail, UserPrivilege, UserRow } from "../../../src/adminapp/api-types";
import type { ColumnSpec } from "../tableColumns";

const route = useRoute();
const router = useRouter();
const list = useFetch<UserRow[]>(() => "/users", false);
const selected = computed(() => (route.params.userId as string | undefined) || null);
const detail = useFetch<UserDetail>(() => (selected.value ? `/users/${selected.value}` : null));

const search = ref("");
const noOrg = ref(false);

const rows = computed(() => (list.data.value ?? []).filter((u) =>
  (!noOrg.value || !u.orgs.length)
  && matches(search.value, u.name, u.discordUsername, u.rsiHandle, u.userId, ...u.orgs)));
const noOrgCount = computed(() => (list.data.value ?? []).filter((u) => !u.orgs.length).length);

// Where actions come from, in this order
const CHANNELS: Record<ActivitySource, string> = { bot: "Bot", webapp: "Web", companion: "Companion" };

const COLUMNS: ColumnSpec[] = [
  { key: "name", label: "Name", width: 200 },
  { key: "rsi", label: "RSI handle", width: 140 },
  { key: "orgs", label: "Orgs", width: 180 },
  { key: "batches", label: "Batches", width: 90 },
  { key: "scu", label: "SCU", width: 100 },
  { key: "harvestables", label: "Harvestables", width: 120 },
  { key: "gear", label: "Gear", width: 80 },
  { key: "jobs", label: "Refinery jobs", width: 120 },
  { key: "blueprints", label: "Blueprints", width: 110 },
  { key: "lastActivity", label: "Last action", width: 160 },
  { key: "lastSeen", label: "Last web login", width: 160 },
  { key: "companion", label: "Companion", width: 110 },
];

function valueOf(u: UserRow, key: string): string | number {
  switch (key) {
    case "name": return u.name ?? u.userId;
    case "rsi": return u.rsiHandle ?? "";
    case "orgs": return u.orgs.join(", ");
    case "batches": return u.batches;
    case "scu": return Number(u.resourceScu);
    case "harvestables": return Number(u.harvestablePcs);
    case "gear": return Number(u.gearPcs);
    case "jobs": return u.refineryJobs;
    case "blueprints": return u.blueprints;
    case "lastActivity": return u.lastActivity ?? "";
    case "lastSeen": return u.lastSeen ?? "";
    default: return u.companion ? 1 : 0;
  }
}

// The detail: identity on top, below it two tabs of folding sections: App (account,
// privileges, orgs) and Stats (the user's data, small key figures first); the tab and which sections are open are remembered per browser
const TABS = ["app", "stats"] as const;
const TAB_LABELS: Record<(typeof TABS)[number], string> = { app: "App", stats: "Stats" };
const tab = useStoredTab("qm.users.detailTab", TABS, "app");
const SECTIONS = ["account", "privileges", "orgs", "stock", "refinery", "blueprints", "history"] as const;
type Section = (typeof SECTIONS)[number];
const OPEN_KEY = "qm.users.sections";
const open = ref<Set<Section>>(new Set(["account", "privileges", "orgs"]));
try {
  const stored = JSON.parse(localStorage.getItem(OPEN_KEY) ?? "null") as unknown;
  if (Array.isArray(stored)) open.value = new Set(SECTIONS.filter((x) => stored.includes(x)));
} catch {
  // Not readable: the default
}
function onToggle(section: Section, ev: Event) {
  const next = new Set(open.value);
  if ((ev.target as HTMLDetailsElement).open) next.add(section);
  else next.delete(section);
  open.value = next;
  try {
    localStorage.setItem(OPEN_KEY, JSON.stringify([...next]));
  } catch {
    // Not remembered
  }
}

// Privileges: assigned until taken back
const privileges = useFetch<UserPrivilege[]>(() => (selected.value ? `/users/${selected.value}/privileges` : null), false);
const held = (p: UserPrivilege) => p.grantedAt !== null;
const privilegeBusy = ref(false);
const privilegeError = ref("");
async function changePrivilege(action: () => Promise<unknown>) {
  privilegeBusy.value = true;
  privilegeError.value = "";
  try {
    await action();
  } catch (e) {
    privilegeError.value = e instanceof Error ? e.message : String(e);
  } finally {
    privilegeBusy.value = false;
    privileges.reload();
  }
}
const grant = (p: UserPrivilege) => changePrivilege(() => send("PUT", `/users/${selected.value}/privileges/${p.key}`, {}));
function revoke(p: UserPrivilege) {
  if (!confirm(`Take back "${p.key}"? Their data stays.`)) return;
  void changePrivilege(() => send("DELETE", `/users/${selected.value}/privileges/${p.key}`));
}
</script>

<template>
  <div class="view">
    <section class="panel list-panel">
      <div class="head">
        <Icon name="user" :size="16" />
        <span class="head-title no-grow">Users</span>
        <div class="divider" />
        <div class="chips">
          <button type="button" class="chip" :class="{ active: noOrg }" @click="noOrg = !noOrg">
            Without org <span class="count">{{ noOrgCount }}</span>
          </button>
        </div>
        <span class="head-count">{{ rows.length }} / {{ list.data.value?.length ?? 0 }}</span>
        <div class="spacer" />
        <div class="search">
          <Icon name="search" :size="14" />
          <input v-model="search" placeholder="Find…" />
          <button v-if="search" type="button" class="clear" title="Clear" @click="search = ''">
            <Icon name="close" :size="12" />
          </button>
        </div>
      </div>
      <div v-if="list.error.value" class="empty-line">{{ list.error.value }}</div>
      <div v-else-if="list.loading.value && !list.data.value" class="empty-line">Loading…</div>
      <DataTable
        v-else
        storage-key="qm.columns.users"
        :columns="COLUMNS"
        :rows="rows"
        :default-sort="{ key: 'name', dir: 'asc' }"
        :row-key="(u) => u.userId"
        :value-of="valueOf"
        :selected="selected"
        :numeric="['batches', 'scu', 'harvestables', 'gear', 'jobs', 'blueprints']"
        empty-text="No users"
        @select="(u) => router.push(`/users/${u.userId}`)"
      >
        <template #cell-name="{ row }">
          <Tooltip :text="row.userId" mono>
            <span v-if="row.name">{{ row.name }}</span>
            <span v-else class="mono faint">{{ row.userId }}</span>
          </Tooltip>
        </template>
        <template #cell-rsi="{ row }"><span :class="{ faint: !row.rsiHandle }">{{ row.rsiHandle ?? "—" }}</span></template>
        <template #cell-orgs="{ row }"><span :class="{ faint: !row.orgs.length }">{{ row.orgs.join(", ") || "—" }}</span></template>
        <template #cell-batches="{ row }"><span :class="{ faint: !row.batches }">{{ row.batches }}</span></template>
        <template #cell-scu="{ row }"><span class="mono" :class="{ faint: row.resourceScu === '0' }">{{ row.resourceScu }}</span></template>
        <template #cell-harvestables="{ row }"><span class="mono" :class="{ faint: row.harvestablePcs === '0' }">{{ row.harvestablePcs }}</span></template>
        <template #cell-gear="{ row }"><span class="mono" :class="{ faint: row.gearPcs === '0' }">{{ row.gearPcs }}</span></template>
        <template #cell-jobs="{ row }"><span :class="{ faint: !row.refineryJobs }">{{ row.refineryJobs }}</span></template>
        <template #cell-blueprints="{ row }"><span :class="{ faint: !row.blueprints }">{{ row.blueprints }}</span></template>
        <template #cell-lastActivity="{ row }"><span :class="{ faint: !row.lastActivity }">{{ dateTime(row.lastActivity) }}</span></template>
        <template #cell-lastSeen="{ row }"><span :class="{ faint: !row.lastSeen }">{{ dateTime(row.lastSeen) }}</span></template>
        <template #cell-companion="{ row }"><span v-if="row.companion" class="tag ok">Token</span></template>
      </DataTable>
    </section>

    <DetailPanel
      v-if="selected"
      icon="user"
      :title="detail.data.value ? detail.data.value.name ?? detail.data.value.userId : '…'"
      :technical="selected"
      :loading="detail.loading.value && !detail.data.value"
      :error="detail.error.value"
      @close="router.push('/users')"
    >
      <template v-if="detail.data.value">
        <section class="ident">
          <div class="ident-line">
            <span :class="{ faint: !detail.data.value.discordUsername }">@{{ detail.data.value.discordUsername ?? "—" }}</span>
            <span class="dim">RSI {{ detail.data.value.rsiHandle ?? "—" }}</span>
          </div>
        </section>

        <div class="chips">
          <button v-for="t in TABS" :key="t" type="button" class="chip" :class="{ active: tab === t }" @click="tab = t">{{ TAB_LABELS[t] }}</button>
        </div>

        <template v-if="tab === 'app'">
          <details class="section" :open="open.has('account')" @toggle="onToggle('account', $event)">
            <summary><Icon name="chevron-right" :size="14" class="chev" /> <span class="panel-title">Account</span></summary>
            <dl class="kv">
              <dt>Discord ID</dt>
              <dd class="mono">{{ detail.data.value.userId }}</dd>
              <dt>Known since</dt>
              <dd>{{ dateTime(detail.data.value.createdAt) }}</dd>
              <dt>Last action</dt>
              <dd>{{ dateTime(detail.data.value.lastActivity) }}</dd>
              <dt>Web app</dt>
              <dd>
                <template v-if="detail.data.value.lastSeen">
                  last seen {{ dateTime(detail.data.value.lastSeen) }} · {{ detail.data.value.sessions }} valid sessions
                </template>
                <span v-else class="faint">never logged in</span>
              </dd>
              <dt>Companion</dt>
              <dd>
                <template v-if="detail.data.value.tokenCreatedAt">
                  token since {{ dateTime(detail.data.value.tokenCreatedAt) }} · last used {{ dateTime(detail.data.value.tokenLastUsedAt) }}
                </template>
                <span v-else class="faint">no token</span>
              </dd>
              <template v-for="(label, c) in CHANNELS" :key="c">
                <dt>{{ label }} (30 d)</dt>
                <dd class="mono" :class="{ faint: !detail.data.value.actions[c] }">{{ detail.data.value.actions[c] }} actions</dd>
              </template>
            </dl>
          </details>
          <details class="section" :open="open.has('privileges')" @toggle="onToggle('privileges', $event)">
            <summary><Icon name="chevron-right" :size="14" class="chev" /> <span class="panel-title">Privileges</span> <span class="count">{{ privileges.data.value?.filter(held).length ?? 0 }}</span></summary>
            <div v-if="privilegeError" class="err">{{ privilegeError }}</div>
            <div v-if="privileges.error.value" class="faint">{{ privileges.error.value }}</div>
            <table v-else-if="privileges.data.value?.length" class="mini">
              <thead><tr><th>Privilege</th><th>State</th><th /></tr></thead>
              <tbody>
                <tr v-for="p in privileges.data.value" :key="p.key">
                  <td><Tooltip :text="p.key" mono>{{ p.description }}</Tooltip></td>
                  <td>
                    <span v-if="!held(p)" class="tag">Not held</span>
                    <span v-else class="tag ok">Held</span>
                    <span v-if="p.retired" class="tag err">Retired</span>
                  </td>
                  <td class="actions">
                    <button v-if="held(p)" type="button" class="icon-btn" title="Take back" :disabled="privilegeBusy" @click="revoke(p)"><Icon name="trash" :size="16" /></button>
                    <button v-else type="button" class="icon-btn" title="Assign" :disabled="privilegeBusy || p.retired" @click="grant(p)"><Icon name="plus" :size="16" /></button>
                  </td>
                </tr>
              </tbody>
            </table>
            <div v-else class="faint">No privileges defined</div>
          </details>
          <details class="section" :open="open.has('orgs')" @toggle="onToggle('orgs', $event)">
            <summary><Icon name="chevron-right" :size="14" class="chev" /> <span class="panel-title">Orgs</span> <span class="count">{{ detail.data.value.memberships.length }}</span></summary>
            <table v-if="detail.data.value.memberships.length" class="mini">
              <thead><tr><th>Org</th><th>Nickname</th><th>State</th><th>Since</th></tr></thead>
              <tbody>
                <tr v-for="m in detail.data.value.memberships" :key="m.guildId" class="link" @click="router.push(`/orgs/${m.guildId}`)">
                  <td>{{ m.org }}</td>
                  <td class="dim">{{ m.displayName }}</td>
                  <td><span class="tag" :class="m.active ? 'ok' : ''">{{ m.active ? "Active" : "Inactive" }}</span></td>
                  <td>{{ dateTime(m.active ? m.firstSeenAt : m.inactiveSince) }}</td>
                </tr>
              </tbody>
            </table>
            <div v-else class="faint">None</div>
          </details>
        </template>
        <template v-else>
          <div class="figures">
            <div class="figure"><span class="figure-value mono" :class="{ faint: !detail.data.value.batches }">{{ detail.data.value.batches }}</span><span class="figure-label">Batches</span></div>
            <div class="figure"><span class="figure-value mono" :class="{ faint: detail.data.value.resourceScu === '0' }">{{ detail.data.value.resourceScu }}</span><span class="figure-label">SCU</span></div>
            <div class="figure"><span class="figure-value mono" :class="{ faint: detail.data.value.harvestablePcs === '0' }">{{ detail.data.value.harvestablePcs }}</span><span class="figure-label">Harvestables</span></div>
            <div class="figure"><span class="figure-value mono" :class="{ faint: detail.data.value.gearPcs === '0' }">{{ detail.data.value.gearPcs }}</span><span class="figure-label">Gear</span></div>
            <div class="figure"><span class="figure-value mono" :class="{ faint: !detail.data.value.refineryJobs }">{{ detail.data.value.refineryJobs }}</span><span class="figure-label">Refinery jobs</span></div>
            <div class="figure"><span class="figure-value mono" :class="{ faint: !detail.data.value.blueprints }">{{ detail.data.value.blueprints }}</span><span class="figure-label">Blueprints</span></div>
          </div>
          <details class="section" :open="open.has('stock')" @toggle="onToggle('stock', $event)">
            <summary><Icon name="chevron-right" :size="14" class="chev" /> <span class="panel-title">Stock</span> <span class="count">{{ detail.data.value.stock.length }}</span></summary>
            <StockTotals :stock="detail.data.value.stock" />
          </details>
          <details class="section" :open="open.has('refinery')" @toggle="onToggle('refinery', $event)">
            <summary><Icon name="chevron-right" :size="14" class="chev" /> <span class="panel-title">Refinery</span> <span class="count">{{ detail.data.value.jobs.length }}</span></summary>
            <table v-if="detail.data.value.jobs.length" class="mini">
              <thead><tr><th>Station</th><th>Materials (expected)</th><th class="num">SCU</th><th>Ends</th></tr></thead>
              <tbody>
                <tr v-for="j in detail.data.value.jobs" :key="j.jobId">
                  <td>{{ j.location }}</td>
                  <td>
                    <div v-for="(m, i) in j.materials" :key="i">
                      {{ m.name }} <span class="mono dim">{{ m.amount }} SCU · Q{{ m.quality }}</span>
                    </div>
                  </td>
                  <td class="num mono">{{ j.scu }}</td>
                  <td>{{ dateTime(j.endsAt) }}</td>
                </tr>
              </tbody>
            </table>
            <div v-else class="faint">No running jobs</div>
          </details>
          <details class="section" :open="open.has('blueprints')" @toggle="onToggle('blueprints', $event)">
            <summary><Icon name="chevron-right" :size="14" class="chev" /> <span class="panel-title">Blueprints</span> <span class="count">{{ detail.data.value.blueprintList.length }}</span></summary>
            <table v-if="detail.data.value.blueprintList.length" class="mini">
              <tbody>
                <tr v-for="b in detail.data.value.blueprintList" :key="b.uuid">
                  <td><RouterLink :to="`/blueprints/${b.uuid}`">{{ b.name }}</RouterLink></td>
                </tr>
              </tbody>
            </table>
            <div v-else class="faint">None</div>
          </details>
          <details class="section" :open="open.has('history')" @toggle="onToggle('history', $event)">
            <summary><Icon name="chevron-right" :size="14" class="chev" /> <span class="panel-title">History</span> <span class="count">{{ detail.data.value.history.length }}</span></summary>
            <table v-if="detail.data.value.history.length" class="mini">
              <thead><tr><th>Time</th><th>Source</th><th>Action</th><th>Target</th><th class="num">Amount</th><th>Org</th></tr></thead>
              <tbody>
                <tr v-for="h in detail.data.value.history" :key="h.id">
                  <td>{{ dateTime(h.at) }}</td>
                  <td class="dim">{{ h.source }}</td>
                  <td>{{ h.category }} · {{ h.action }}<span v-if="h.byOther" class="faint"> (by someone else)</span></td>
                  <td>{{ h.target }}</td>
                  <td class="num mono">{{ h.amount ? `${h.amount} ${h.unit}` : "" }}</td>
                  <td class="dim">{{ h.org ?? "" }}</td>
                </tr>
              </tbody>
            </table>
            <div v-else class="faint">None</div>
            <RouterLink :to="{ path: '/activity', query: { user: detail.data.value.userId } }">All in Activity</RouterLink>
          </details>
        </template>
      </template>
    </DetailPanel>
  </div>
</template>

<style scoped>
.ident {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.ident-line {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
  font-size: 13px;
}

/* The Stats tab's key figures: small, in one row as far as the panel allows */
.figures {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.figure {
  display: flex;
  align-items: baseline;
  gap: 5px;
  padding: 3px 8px;
  border: 1px solid var(--border-dim);
  border-radius: var(--radius-control);
  background: var(--bg-surface-2);
}

.figure-value {
  font-size: 13px;
  font-weight: 600;
  color: var(--text);
}

.figure-label {
  font-size: 11px;
  color: var(--text-3);
}

/* Folding sections: the head a full-width row, the chevron turning when open */
.section {
  border-top: 1px solid var(--border-dim);
  padding-top: 10px;
}

.section > summary {
  display: flex;
  align-items: center;
  gap: 6px;
  cursor: pointer;
  list-style: none;
  user-select: none;
}

.section > summary::-webkit-details-marker {
  display: none;
}

.section > summary .count {
  font-size: 11px;
  color: var(--text-2);
}

.chev {
  color: var(--text-3);
  transition: transform 0.15s;
}

.section[open] > summary .chev {
  transform: rotate(90deg);
}

.section[open] > summary {
  margin-bottom: 10px;
}

.err {
  color: var(--err);
}

.actions {
  width: 1%;
}
</style>
