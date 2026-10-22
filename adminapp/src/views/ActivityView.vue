<script setup lang="ts">
// Everything users did (app.history), newest first, 100 per page ("Load more" follows the id cursor). The
// filters live in the route query (source, category, action, guild, user, days): other pages link here with
// ?user=<id> or ?guild=<id>. A row unfolds to its raw details.
import { computed, ref, watch } from "vue";
import { RouterLink, useRoute, useRouter } from "vue-router";
import Dropdown from "../components/Dropdown.vue";
import Icon from "../components/Icon.vue";
import RawJson from "../components/RawJson.vue";
import Tooltip from "../components/Tooltip.vue";
import { get, useFetch } from "../api";
import { ago, dateTime } from "../format";
import { lang } from "../lang";
import { ACTIONS, CATEGORY_LABEL, SOURCE_LABEL, amountText } from "../activity";
import type { ActivityResponse, ActivityRow, OrgRow, UserRef } from "../../../src/adminapp/api-types";

const route = useRoute();
const router = useRouter();
const orgList = useFetch<OrgRow[]>(() => "/orgs", false);

const FILTERS = ["source", "category", "action", "guild", "user", "days"] as const;
type FilterKey = (typeof FILTERS)[number];
const filter = computed(() => Object.fromEntries(FILTERS.map((k) => [k, typeof route.query[k] === "string" ? route.query[k] : ""])) as Record<FilterKey, string>);

function setFilter(key: FilterKey, value: string) {
  const query = { ...route.query, [key]: value || undefined };
  // An action of another category would match nothing
  if (key === "category" && value && filter.value.action && !ACTIONS[value as ActivityRow["category"]]?.includes(filter.value.action)) query.action = undefined;
  void router.replace({ query });
}

const sourceOptions = [{ value: "", label: "All sources" }, ...Object.entries(SOURCE_LABEL).map(([value, label]) => ({ value, label }))];
const categoryOptions = [{ value: "", label: "All categories" }, ...Object.entries(CATEGORY_LABEL).map(([value, label]) => ({ value, label }))];
const actionOptions = computed(() => {
  const c = filter.value.category as ActivityRow["category"] | "";
  const actions = c ? ACTIONS[c] : [...new Set(Object.values(ACTIONS).flat())].sort();
  return [{ value: "", label: "All actions" }, ...actions.map((a) => ({ value: a, label: a }))];
});
const orgOptions = computed(() => [
  { value: "", label: "All orgs" },
  ...(orgList.data.value ?? []).map((o) => ({ value: o.guildId, label: o.name })),
]);
const dayOptions = [
  { value: "", label: "Any time" }, { value: "1", label: "24 h" }, { value: "7", label: "7 days" },
  { value: "30", label: "30 days" }, { value: "90", label: "90 days" },
];

// --- rows: the first page on every filter or language change, then appended pages ---
const rows = ref<ActivityRow[]>([]);
const next = ref<number | null>(null);
const loading = ref(false);
const error = ref("");
// Unfolded rows (ids)
const open = ref(new Set<number>());
let seq = 0;

async function load(more = false) {
  const mine = ++seq;
  loading.value = true;
  error.value = "";
  try {
    const params: Record<string, string | number | undefined> = { ...filter.value, lang: lang.value };
    if (more && next.value !== null) params.before = next.value;
    const page = await get<ActivityResponse>("/activity", params);
    if (mine !== seq) return;
    rows.value = more ? [...rows.value, ...page.rows] : page.rows;
    next.value = page.next;
    if (!more) open.value = new Set();
  } catch (e) {
    if (mine === seq) error.value = e instanceof Error ? e.message : String(e);
  } finally {
    if (mine === seq) loading.value = false;
  }
}
// Only while this page is shown (the watcher would also fire on the way to another page)
watch(() => [route.name === "activity" ? JSON.stringify(filter.value) : null, lang.value] as const, ([f]) => f !== null && load(), { immediate: true });

function toggle(id: number) {
  const s = new Set(open.value);
  if (!s.delete(id)) s.add(id);
  open.value = s;
}

// The filtered user's name, from any row that names them
const userName = computed(() => {
  const id = filter.value.user;
  if (!id) return "";
  for (const r of rows.value) for (const u of [r.actor, r.owner, r.toOwner]) if (u?.userId === id && u.name) return u.name;
  return id;
});
const name = (u: UserRef) => u.name ?? u.userId;
</script>

<template>
  <div class="view">
    <section class="panel list-panel">
      <div class="head">
        <Icon name="activity" :size="16" />
        <span class="head-title no-grow">Activity</span>
        <span class="head-count">{{ rows.length }}{{ next !== null ? "+" : "" }}</span>
        <div class="divider" />
        <Dropdown :model-value="filter.source" :options="sourceOptions" variant="small" @update:model-value="(v) => setFilter('source', v)" />
        <Dropdown :model-value="filter.category" :options="categoryOptions" variant="small" @update:model-value="(v) => setFilter('category', v)" />
        <Dropdown :model-value="filter.action" :options="actionOptions" variant="small" @update:model-value="(v) => setFilter('action', v)" />
        <Dropdown :model-value="filter.guild" :options="orgOptions" variant="small" @update:model-value="(v) => setFilter('guild', v)" />
        <Dropdown :model-value="filter.days" :options="dayOptions" variant="small" @update:model-value="(v) => setFilter('days', v)" />
        <button v-if="filter.user" type="button" class="chip active" title="Remove the user filter" @click="setFilter('user', '')">
          {{ userName }} <Icon name="close" :size="12" />
        </button>
        <div class="spacer" />
        <button type="button" class="btn outline small" @click="load()"><Icon name="refresh" :size="14" /> Refresh</button>
      </div>
      <div v-if="error && !rows.length" class="empty-line">{{ error }}</div>
      <div v-else-if="loading && !rows.length" class="empty-line">Loading…</div>
      <div v-else class="scroll">
        <table class="mini">
          <thead>
            <tr>
              <th class="chev" /><th>Time</th><th>Source</th><th>Action</th><th>By</th><th>Target</th><th class="num">Amount</th>
              <th class="num">Quality</th><th>Location</th><th>Org</th>
            </tr>
          </thead>
          <tbody>
            <template v-for="r in rows" :key="r.id">
              <tr class="link" :class="{ unfolded: open.has(r.id) }" @click="toggle(r.id)">
                <td class="chev faint"><Icon :name="open.has(r.id) ? 'chevron-down' : 'chevron-right'" :size="12" /></td>
                <td class="nowrap" :title="dateTime(r.at)">{{ dateTime(r.at) }} <span class="faint">· {{ ago(r.at) }}</span></td>
                <td class="dim">{{ SOURCE_LABEL[r.source] }}</td>
                <td class="nowrap">{{ r.category }} · {{ r.action }}</td>
                <td>
                  <RouterLink :to="`/users/${r.actor.userId}`" @click.stop>{{ name(r.actor) }}</RouterLink>
                  <template v-if="r.toOwner">
                    <span class="dim"> → </span><RouterLink :to="`/users/${r.toOwner.userId}`" @click.stop>{{ name(r.toOwner) }}</RouterLink>
                  </template>
                  <template v-else-if="r.owner.userId !== r.actor.userId">
                    <span class="dim"> for </span><RouterLink :to="`/users/${r.owner.userId}`" @click.stop>{{ name(r.owner) }}</RouterLink>
                  </template>
                </td>
                <td><Tooltip :text="r.targetUuid" mono>{{ r.target }}</Tooltip></td>
                <td class="num mono">{{ amountText(r) }}</td>
                <td class="num mono" :class="{ faint: r.quality === null }">{{ r.quality ?? "" }}</td>
                <td class="dim">{{ r.location ?? "" }}<template v-if="r.toLocation"> → {{ r.toLocation }}</template></td>
                <td>
                  <RouterLink v-if="r.guildId" :to="`/orgs/${r.guildId}`" @click.stop>{{ r.org ?? r.guildId }}</RouterLink>
                </td>
              </tr>
              <tr v-if="open.has(r.id)" class="details">
                <td />
                <td colspan="9"><RawJson :value="r.details" label="Details" unfolded /></td>
              </tr>
            </template>
          </tbody>
        </table>
        <div v-if="!rows.length" class="empty-line">No actions</div>
        <div v-if="next !== null || error" class="more">
          <span v-if="error" class="warning">{{ error }}</span>
          <button v-if="next !== null" type="button" class="btn outline small" :disabled="loading" @click="load(true)">
            {{ loading ? "Loading…" : "Load more" }}
          </button>
        </div>
      </div>
    </section>
  </div>
</template>

<style scoped>
.scroll {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 4px 8px 12px;
}

.chev {
  width: 14px;
  padding-right: 0;
}

.nowrap {
  white-space: nowrap;
}

.mini tr.unfolded td {
  border-bottom: none;
}

.mini tr.details td {
  padding-top: 0;
}

.more {
  display: flex;
  justify-content: center;
  align-items: center;
  gap: 12px;
  padding-top: 12px;
}
</style>
