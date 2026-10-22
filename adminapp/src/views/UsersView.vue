<script setup lang="ts">
// Every known user (app_user, web logins, companion tokens) with a rough look at their data; read-only.
import { computed, ref } from "vue";
import { RouterLink, useRoute, useRouter } from "vue-router";
import DataTable from "../components/DataTable.vue";
import DetailPanel from "../components/DetailPanel.vue";
import Icon from "../components/Icon.vue";
import StockTotals from "../components/StockTotals.vue";
import Tooltip from "../components/Tooltip.vue";
import { useFetch } from "../api";
import { dateTime, matches } from "../format";
import { useStoredTab } from "../storedTab";
import type { ActivitySource, UserDetail, UserRow } from "../../../src/adminapp/api-types";
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
const channelsOf = (u: UserRow) => (Object.keys(CHANNELS) as ActivitySource[]).filter((c) => u.channels.includes(c));

const COLUMNS: ColumnSpec[] = [
  { key: "name", label: "Name", width: 200 },
  { key: "rsi", label: "RSI handle", width: 140 },
  { key: "orgs", label: "Orgs", width: 180 },
  { key: "channels", label: "Channels (30 d)", width: 170 },
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
    case "channels": return channelsOf(u).join(" ");
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

const TABS = ["overview", "stock", "refinery", "blueprints", "history"] as const;
const TAB_LABELS: Record<(typeof TABS)[number], string> = {
  overview: "Overview", stock: "Stock", refinery: "Refinery", blueprints: "Blueprints", history: "History",
};
const tab = useStoredTab("qm.users.tab", TABS, "overview");
// Entries per tab, shown in its chip (none for the overview)
function tabCount(t: (typeof TABS)[number]): number | null {
  const d = detail.data.value;
  if (!d) return null;
  if (t === "stock") return d.stock.length;
  if (t === "refinery") return d.jobs.length;
  if (t === "blueprints") return d.blueprintList.length;
  if (t === "history") return d.history.length;
  return null;
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
        <template #cell-channels="{ row }">
          <span v-if="row.channels.length" class="channels">
            <span v-for="c in channelsOf(row)" :key="c" class="tag">{{ CHANNELS[c] }}</span>
          </span>
          <span v-else class="faint">—</span>
        </template>
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
        <div class="chips">
          <button v-for="t in TABS" :key="t" type="button" class="chip" :class="{ active: tab === t }" @click="tab = t">
            {{ TAB_LABELS[t] }} <span v-if="tabCount(t) !== null" class="count">{{ tabCount(t) }}</span>
          </button>
        </div>

        <template v-if="tab === 'overview'">
          <section>
            <dl class="kv">
              <dt>Discord ID</dt>
              <dd class="mono">{{ detail.data.value.userId }}</dd>
              <dt>Username</dt>
              <dd :class="{ faint: !detail.data.value.discordUsername }">{{ detail.data.value.discordUsername ?? "—" }}</dd>
              <dt>RSI handle</dt>
              <dd :class="{ faint: !detail.data.value.rsiHandle }">{{ detail.data.value.rsiHandle ?? "—" }}</dd>
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
            </dl>
          </section>

          <section>
            <span class="panel-title">Actions in the last 30 days</span>
            <dl class="kv">
              <template v-for="(label, c) in CHANNELS" :key="c">
                <dt>{{ label }}</dt>
                <dd class="mono" :class="{ faint: !detail.data.value.actions[c] }">{{ detail.data.value.actions[c] }}</dd>
              </template>
            </dl>
          </section>

          <section>
            <span class="panel-title">Orgs</span>
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
          </section>
        </template>

        <StockTotals v-else-if="tab === 'stock'" :stock="detail.data.value.stock" />

        <section v-else-if="tab === 'refinery'">
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
        </section>

        <section v-else-if="tab === 'blueprints'">
          <table v-if="detail.data.value.blueprintList.length" class="mini">
            <tbody>
              <tr v-for="b in detail.data.value.blueprintList" :key="b.uuid">
                <td><RouterLink :to="`/blueprints/${b.uuid}`">{{ b.name }}</RouterLink></td>
              </tr>
            </tbody>
          </table>
          <div v-else class="faint">None</div>
        </section>

        <section v-else>
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
        </section>
      </template>
    </DetailPanel>
  </div>
</template>

<style scoped>
.channels {
  display: inline-flex;
  gap: 4px;
}
</style>
