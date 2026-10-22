<script setup lang="ts">
// Every org (Discord server with /qm-setup): bot state, settings, roster, what is shared there and its history; read-only.
import { computed, ref } from "vue";
import { RouterLink, useRoute, useRouter } from "vue-router";
import DataTable from "../components/DataTable.vue";
import DetailPanel from "../components/DetailPanel.vue";
import Icon from "../components/Icon.vue";
import StockTotals from "../components/StockTotals.vue";
import Tooltip from "../components/Tooltip.vue";
import { useFetch } from "../api";
import { ago, dateTime, matches } from "../format";
import { useStoredTab } from "../storedTab";
import type { OrgDetail, OrgRow, StatusResponse } from "../../../src/adminapp/api-types";
import type { ColumnSpec } from "../tableColumns";

const route = useRoute();
const router = useRouter();
const list = useFetch<OrgRow[]>(() => "/orgs", false);
const selected = computed(() => (route.params.guildId as string | undefined) || null);
const detail = useFetch<OrgDetail>(() => (selected.value ? `/orgs/${selected.value}` : null));

const search = ref("");
const rows = computed(() => (list.data.value ?? []).filter((o) => matches(search.value, o.name, o.guildId)));

const COLUMNS: ColumnSpec[] = [
  { key: "name", label: "Name", width: 220 },
  { key: "bot", label: "Bot", width: 90 },
  { key: "members", label: "Members", width: 100 },
  { key: "inactive", label: "Inactive", width: 90 },
  { key: "roles", label: "Member roles", width: 120 },
  { key: "lang", label: "Language", width: 100 },
  { key: "logs", label: "Logs", width: 90 },
  { key: "board", label: "Board", width: 90 },
  { key: "shared", label: "Shared batches", width: 130 },
  { key: "lastActivity", label: "Last action", width: 160 },
  { key: "createdAt", label: "Set up", width: 160 },
];

function valueOf(o: OrgRow, key: string): string | number {
  switch (key) {
    case "name": return o.name;
    case "bot": return o.leftAt ? 0 : 1;
    case "members": return o.membersActive;
    case "inactive": return o.membersInactive;
    case "roles": return o.memberRoles;
    case "lang": return o.baseLang ?? "";
    case "logs": return logs(o);
    case "board": return board(o);
    case "shared": return o.sharedBatches;
    case "lastActivity": return o.lastActivity ?? "";
    default: return o.createdAt;
  }
}

// The level only counts with a channel
const logs = (o: OrgRow) => (o.logsChannelId && o.logsLevel !== "off" ? o.logsLevel ?? "" : "off");
// No channel = no board
const board = (o: OrgRow) => (o.boardChannelId ? o.boardStyle ?? "" : "off");

const TABS = ["roster", "stock", "bot", "activity"] as const;
const TAB_LABELS: Record<(typeof TABS)[number], string> = { roster: "Roster", stock: "Shared stock", bot: "Bot", activity: "Activity" };
const tab = useStoredTab("qm.orgs.tab", TABS, "roster");
function tabCount(t: (typeof TABS)[number]): number | null {
  const d = detail.data.value;
  if (!d) return null;
  if (t === "roster") return d.members.length;
  if (t === "stock") return d.stock.length;
  if (t === "activity") return d.activity.length;
  return null;
}

// The logs channel's state comes from the status check, loaded only for the Bot tab
const status = useFetch<StatusResponse>(() => (selected.value && tab.value === "bot" ? "/status" : null), false);
const logsState = computed(() => status.data.value?.botLogs.find((g) => g.guildId === selected.value) ?? null);
const LOGS_STATE = { ok: "Working", warn: "Behind", err: "Stuck" } as const;
</script>

<template>
  <div class="view">
    <section class="panel list-panel">
      <div class="head">
        <Icon name="users" :size="16" />
        <span class="head-title no-grow">Orgs</span>
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
        storage-key="qm.columns.orgs"
        :columns="COLUMNS"
        :rows="rows"
        :default-sort="{ key: 'name', dir: 'asc' }"
        :row-key="(o) => o.guildId"
        :value-of="valueOf"
        :selected="selected"
        :row-class="(o) => ({ retired: !!o.leftAt })"
        :numeric="['members', 'inactive', 'roles', 'shared']"
        empty-text="No orgs"
        @select="(o) => router.push(`/orgs/${o.guildId}`)"
      >
        <template #cell-name="{ row }"><Tooltip :text="row.guildId" mono>{{ row.name }}</Tooltip></template>
        <template #cell-bot="{ row }">
          <span v-if="row.leftAt" class="tag err">Left</span>
          <span v-else class="tag ok">Present</span>
        </template>
        <template #cell-inactive="{ row }"><span :class="{ faint: !row.membersInactive }">{{ row.membersInactive }}</span></template>
        <template #cell-roles="{ row }"><span :class="{ faint: !row.memberRoles }">{{ row.memberRoles }}</span></template>
        <template #cell-lang="{ row }"><span class="mono">{{ row.baseLang ?? "—" }}</span></template>
        <template #cell-logs="{ row }"><span class="mono" :class="{ faint: logs(row) === 'off' }">{{ logs(row) }}</span></template>
        <template #cell-board="{ row }"><span class="mono" :class="{ faint: board(row) === 'off' }">{{ board(row) }}</span></template>
        <template #cell-shared="{ row }"><span :class="{ faint: !row.sharedBatches }">{{ row.sharedBatches }}</span></template>
        <template #cell-lastActivity="{ row }"><span :class="{ faint: !row.lastActivity }">{{ dateTime(row.lastActivity) }}</span></template>
        <template #cell-createdAt="{ row }">{{ dateTime(row.createdAt) }}</template>
      </DataTable>
    </section>

    <DetailPanel
      v-if="selected"
      icon="users"
      :title="detail.data.value?.name ?? '…'"
      :technical="selected"
      :loading="detail.loading.value && !detail.data.value"
      :error="detail.error.value"
      @close="router.push('/orgs')"
    >
      <template v-if="detail.data.value">
        <div class="chips">
          <button v-for="t in TABS" :key="t" type="button" class="chip" :class="{ active: tab === t }" @click="tab = t">
            {{ TAB_LABELS[t] }} <span v-if="tabCount(t) !== null" class="count">{{ tabCount(t) }}</span>
          </button>
        </div>

        <section v-if="tab === 'roster'">
          <dl class="kv">
            <dt>Member roles</dt>
            <dd :class="{ faint: !detail.data.value.memberRoles }">{{ detail.data.value.memberRoles }}</dd>
            <dt>Members</dt>
            <dd>{{ detail.data.value.membersActive }} active<span class="faint"> · {{ detail.data.value.membersInactive }} inactive</span></dd>
          </dl>
          <table v-if="detail.data.value.members.length" class="mini">
            <thead><tr><th>Name</th><th>Nickname</th><th>RSI handle</th><th>State</th><th>Since</th></tr></thead>
            <tbody>
              <tr v-for="m in detail.data.value.members" :key="m.userId" class="link" @click="router.push(`/users/${m.userId}`)">
                <td><Tooltip :text="m.userId" mono>{{ m.name ?? m.displayName }}</Tooltip></td>
                <td class="dim">{{ m.displayName }}</td>
                <td :class="{ faint: !m.rsiHandle }">{{ m.rsiHandle ?? "—" }}</td>
                <td><span class="tag" :class="m.active ? 'ok' : ''">{{ m.active ? "Active" : "Inactive" }}</span></td>
                <td>{{ dateTime(m.active ? m.firstSeenAt : m.inactiveSince) }}</td>
              </tr>
            </tbody>
          </table>
          <div v-else class="faint">None</div>
        </section>

        <StockTotals v-else-if="tab === 'stock'" :stock="detail.data.value.stock" org />

        <template v-else-if="tab === 'bot'">
          <section>
            <dl class="kv">
              <dt>Bot</dt>
              <dd>
                <template v-if="detail.data.value.leftAt"><span class="tag err">Left</span> {{ dateTime(detail.data.value.leftAt) }}</template>
                <template v-else-if="detail.data.value.joinedAt"><span class="tag ok">Present</span> since {{ dateTime(detail.data.value.joinedAt) }}</template>
                <span v-else class="faint">no bot settings</span>
              </dd>
              <dt>Set up</dt>
              <dd>{{ dateTime(detail.data.value.createdAt) }}</dd>
              <dt>Base language</dt>
              <dd class="mono">{{ detail.data.value.baseLang ?? "—" }}</dd>
            </dl>
          </section>

          <section>
            <span class="panel-title">Logs channel</span>
            <dl class="kv">
              <dt>Level</dt>
              <dd class="mono" :class="{ faint: logs(detail.data.value) === 'off' }">{{ logs(detail.data.value) }}</dd>
              <dt>Channel</dt>
              <dd class="mono" :class="{ faint: !detail.data.value.logsChannelId }">{{ detail.data.value.logsChannelId ?? "—" }}</dd>
              <template v-if="logsState">
                <dt>State</dt>
                <dd>
                  <span class="tag" :class="logsState.state">{{ logsState.marked ? LOGS_STATE[logsState.state] : "No mark" }}</span>
                  <span class="faint">
                    · {{ logsState.pending >= 100 ? "100+" : logsState.pending }} waiting<template v-if="logsState.oldestPendingAt">, oldest {{ ago(logsState.oldestPendingAt) }} ago</template>
                  </span>
                </dd>
              </template>
            </dl>
          </section>

          <section>
            <span class="panel-title">Board</span>
            <dl v-if="detail.data.value.boardChannelId" class="kv">
              <dt>Channel</dt>
              <dd class="mono">{{ detail.data.value.boardChannelId }}</dd>
              <dt>Message</dt>
              <dd class="mono" :class="{ faint: !detail.data.value.boardMessageId }">{{ detail.data.value.boardMessageId ?? "not posted yet" }}</dd>
              <dt>Style</dt>
              <dd class="mono">{{ detail.data.value.boardStyle }}</dd>
              <dt>Title</dt>
              <dd :class="{ faint: !detail.data.value.boardTitle }">{{ detail.data.value.boardTitle ?? detail.data.value.name }}</dd>
              <dt>Subtitle</dt>
              <dd :class="{ faint: !detail.data.value.boardSubtitle }">{{ detail.data.value.boardSubtitle ?? "—" }}</dd>
            </dl>
            <div v-else class="faint">Off</div>
          </section>
        </template>

        <section v-else>
          <dl class="kv">
            <dt>Last action</dt>
            <dd>{{ dateTime(detail.data.value.lastActivity) }}</dd>
          </dl>
          <table v-if="detail.data.value.activity.length" class="mini">
            <thead><tr><th>Time</th><th>User</th><th>Source</th><th>Action</th><th>Target</th><th class="num">Amount</th></tr></thead>
            <tbody>
              <tr v-for="h in detail.data.value.activity" :key="h.id">
                <td>{{ dateTime(h.at) }}</td>
                <td>
                  <RouterLink :to="`/users/${h.actorUserId}`">
                    <span v-if="h.actorName">{{ h.actorName }}</span><span v-else class="mono">{{ h.actorUserId }}</span>
                  </RouterLink>
                </td>
                <td class="dim">{{ h.source }}</td>
                <td>{{ h.category }} · {{ h.action }}</td>
                <td>{{ h.target }}</td>
                <td class="num mono">{{ h.amount ? `${h.amount} ${h.unit}` : "" }}</td>
              </tr>
            </tbody>
          </table>
          <div v-else class="faint">None</div>
          <RouterLink :to="{ path: '/activity', query: { guild: detail.data.value.guildId } }">All in Activity</RouterLink>
        </section>
      </template>
    </DetailPanel>
  </div>
</template>
