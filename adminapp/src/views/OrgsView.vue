<script setup lang="ts">
// Every org (Discord server with /qm-setup): bot state, settings, roster and what is shared there; read-only.
import { computed, ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import DataTable from "../components/DataTable.vue";
import DetailPanel from "../components/DetailPanel.vue";
import Icon from "../components/Icon.vue";
import Tooltip from "../components/Tooltip.vue";
import { useFetch } from "../api";
import { dateTime, matches } from "../format";
import type { OrgDetail, OrgRow } from "../../../src/adminapp/api-types";
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
    case "shared": return o.sharedBatches;
    case "lastActivity": return o.lastActivity ?? "";
    default: return o.createdAt;
  }
}

// The level only counts with a channel
const logs = (o: OrgRow) => (o.logsChannelId && o.logsLevel !== "off" ? o.logsLevel ?? "" : "off");
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
        <section>
          <dl class="kv">
            <dt>Guild ID</dt>
            <dd class="mono">{{ detail.data.value.guildId }}</dd>
            <dt>Bot</dt>
            <dd>
              <template v-if="detail.data.value.leftAt"><span class="tag err">Left</span> {{ dateTime(detail.data.value.leftAt) }}</template>
              <template v-else><span class="tag ok">Present</span> since {{ dateTime(detail.data.value.joinedAt) }}</template>
            </dd>
            <dt>Set up</dt>
            <dd>{{ dateTime(detail.data.value.createdAt) }}</dd>
            <dt>Member roles</dt>
            <dd :class="{ faint: !detail.data.value.memberRoles }">{{ detail.data.value.memberRoles }}</dd>
            <dt>Base language</dt>
            <dd class="mono">{{ detail.data.value.baseLang ?? "—" }}</dd>
            <dt>Logs</dt>
            <dd>
              <span class="mono">{{ logs(detail.data.value) }}</span>
              <span v-if="detail.data.value.logsChannelId" class="faint mono"> · channel {{ detail.data.value.logsChannelId }}</span>
            </dd>
            <dt>Last action</dt>
            <dd>{{ dateTime(detail.data.value.lastActivity) }}</dd>
          </dl>
        </section>

        <section>
          <span class="panel-title">Members</span>
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

        <section>
          <span class="panel-title">Shared stock</span>
          <table v-if="detail.data.value.stock.length" class="mini">
            <thead><tr><th>Material</th><th class="num">Amount</th><th class="num">Batches</th><th class="num">Owners</th><th class="num">Quality</th></tr></thead>
            <tbody>
              <tr v-for="s in detail.data.value.stock" :key="s.uuid">
                <td>{{ s.name }}</td>
                <td class="num mono">{{ s.total }} {{ s.unit }}</td>
                <td class="num mono">{{ s.batches }}</td>
                <td class="num mono">{{ s.owners }}</td>
                <td class="num mono">{{ s.minQuality === s.maxQuality ? s.minQuality : `${s.minQuality}–${s.maxQuality}` }}</td>
              </tr>
            </tbody>
          </table>
          <div v-else class="faint">None</div>
        </section>
      </template>
    </DetailPanel>
  </div>
</template>
