<script setup lang="ts">
// Features (docs/adminapp.md "Features"): the features from the migrations with their privileges, holders and data;
// assigning privileges happens per user (Users, section Privileges). The export packs a feature's rows and images as ZIP.
import { computed } from "vue";
import { RouterLink, useRoute, useRouter } from "vue-router";
import DetailPanel from "../components/DetailPanel.vue";
import Icon from "../components/Icon.vue";
import Tooltip from "../components/Tooltip.vue";
import { useFetch } from "../api";
import { dateTime } from "../format";
import { thumbPath } from "../../../src/thumbs";
import type { FeatureDetail, FeatureEntryRow, FeatureRow } from "../../../src/adminapp/api-types";

const route = useRoute();
const router = useRouter();
const list = useFetch<FeatureRow[]>(() => "/features", false);
const selected = computed(() => (route.params.key as string | undefined) || null);
const detail = useFetch<FeatureDetail>(() => (selected.value ? `/features/${selected.value}` : null));
// A holder's privilege by its description
const privilegeName = (key: string) => detail.data.value?.privileges.find((p) => p.key === key)?.description ?? key;

const blobUrl = (e: FeatureEntryRow) => `/api/features/${selected.value}/blob/${e.id}?v=${encodeURIComponent(e.updatedAt)}`;
// thumb-review: the thumbnail as it is now; marked on another hash = re-rendered since
const marked = (e: FeatureEntryRow) => (typeof e.payload.hash === "string" ? e.payload.hash : null);
const stale = (e: FeatureEntryRow) => marked(e) !== null && e.thumb !== null && marked(e) !== e.thumb;
</script>

<template>
  <div class="view">
    <section class="panel list-panel">
      <div class="head">
        <Icon name="lock" :size="16" />
        <span class="head-title no-grow">Features</span>
        <span class="head-count">{{ list.data.value?.length ?? 0 }}</span>
      </div>
      <div v-if="list.error.value" class="empty-line">{{ list.error.value }}</div>
      <div v-else-if="!list.data.value" class="empty-line">Loading…</div>
      <div v-else-if="!list.data.value.length" class="empty-line">No features</div>
      <table v-else class="mini">
        <thead><tr><th>Feature</th><th class="num">Privileges</th><th class="num">Holders</th><th class="num">Entries</th><th>Since</th><th /></tr></thead>
        <tbody>
          <tr v-for="p in list.data.value" :key="p.key" class="link" :class="{ selected: p.key === selected }" @click="router.push(`/features/${p.key}`)">
            <td><Tooltip :text="p.key" mono>{{ p.description }}</Tooltip></td>
            <td class="num mono" :class="{ faint: !p.privileges.length }">{{ p.privileges.length }}</td>
            <td class="num mono" :class="{ faint: !p.holderCount }">{{ p.holderCount }}</td>
            <td class="num mono" :class="{ faint: !p.entryCount }">{{ p.entryCount }}</td>
            <td class="nowrap">{{ dateTime(p.createdAt) }}</td>
            <td><span v-if="p.retiredAt" class="tag err">Retired</span></td>
          </tr>
        </tbody>
      </table>
    </section>

    <DetailPanel
      v-if="selected"
      icon="lock"
      :title="detail.data.value?.description ?? '…'"
      :technical="selected"
      :loading="detail.loading.value && !detail.data.value"
      :error="detail.error.value"
      @close="router.push('/features')"
    >
      <template v-if="detail.data.value">
        <section>
          <span class="panel-title">Privileges</span>
          <table v-if="detail.data.value.privileges.length" class="mini">
            <thead><tr><th>Privilege</th><th class="num">Holders</th><th /></tr></thead>
            <tbody>
              <tr v-for="p in detail.data.value.privileges" :key="p.key">
                <td><Tooltip :text="p.key" mono>{{ p.description }}</Tooltip></td>
                <td class="num mono" :class="{ faint: !p.holderCount }">{{ p.holderCount }}</td>
                <td><span v-if="p.retired" class="tag err">Retired</span></td>
              </tr>
            </tbody>
          </table>
          <div v-else class="faint">None</div>
        </section>

        <section>
          <span class="panel-title">Holders</span>
          <table v-if="detail.data.value.holders.length" class="mini">
            <thead><tr><th>User</th><th>Privilege</th><th>Since</th></tr></thead>
            <tbody>
              <tr v-for="h in detail.data.value.holders" :key="`${h.userId}:${h.privilegeKey}`" class="link" @click="router.push(`/users/${h.userId}`)">
                <td><Tooltip :text="h.userId" mono>{{ h.name ?? h.userId }}</Tooltip></td>
                <td class="dim">{{ privilegeName(h.privilegeKey) }}</td>
                <td class="nowrap">{{ dateTime(h.grantedAt) }}</td>
              </tr>
            </tbody>
          </table>
          <div v-else class="faint">Nobody; assign it in <RouterLink to="/users">Users</RouterLink></div>
        </section>

        <section>
          <div class="entries-head">
            <span class="panel-title">Entries</span>
            <a class="btn outline small" :href="`/api/features/${selected}/export`" :class="{ disabled: !detail.data.value.entries.length }">
              <Icon name="file" :size="14" /> Export ZIP
            </a>
          </div>
          <table v-if="detail.data.value.entries.length" class="mini">
            <thead><tr><th>Subject</th><th>By</th><th>Changed</th><th>Now</th><th>Reference</th></tr></thead>
            <tbody>
              <tr v-for="e in detail.data.value.entries" :key="e.id">
                <td>
                  <Tooltip :text="[e.className, e.type && `${e.type} / ${e.subType ?? ''}`, e.subject, JSON.stringify(e.payload)].filter(Boolean).join('\n')" mono>
                    {{ e.subjectName ?? e.subject }}
                  </Tooltip>
                  <span v-if="stale(e)" class="tag accent">Re-rendered</span>
                </td>
                <td><RouterLink :to="`/users/${e.userId}`">{{ e.userName ?? e.userId }}</RouterLink></td>
                <td class="nowrap">{{ dateTime(e.updatedAt) }}</td>
                <td>
                  <img v-if="e.thumb" class="pic" :src="thumbPath('l', e.subject, e.thumb)" alt="" />
                </td>
                <td>
                  <a v-if="e.blobType" :href="blobUrl(e)" target="_blank" rel="noopener"><img class="pic ref" :src="blobUrl(e)" alt="" /></a>
                  <span v-else class="faint">—</span>
                </td>
              </tr>
            </tbody>
          </table>
          <div v-else class="faint">None</div>
        </section>
      </template>
    </DetailPanel>
  </div>
</template>

<style scoped>
.nowrap {
  white-space: nowrap;
}

tr.selected td {
  background: var(--bg-surface-2);
}

.entries-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}

.btn.disabled {
  opacity: 0.4;
  pointer-events: none;
}

a.btn {
  text-decoration: none;
}

.pic {
  display: block;
  width: 64px;
  height: 64px;
  object-fit: contain;
}

.pic.ref {
  border: 1px solid var(--warn);
  border-radius: var(--radius-control);
  background: #000;
}
</style>
