<script setup lang="ts">
// Is everything running, is it used, do the data hold — at a glance: what needs action, the key figures,
// actions per day, the latest actions, reach, orgs and the data sources. Every figure links to the page
// that explains it. Reloads on Refresh and when the window regains focus.
import { computed, onMounted, onUnmounted, ref } from "vue";
import { RouterLink, useRouter } from "vue-router";
import DayBars from "../components/DayBars.vue";
import Icon from "../components/Icon.vue";
import Sparkline from "../components/Sparkline.vue";
import { useFetch } from "../api";
import { ago, dateTime } from "../format";
import { CATEGORY_LABEL, SOURCE_LABEL, amountText } from "../activity";
import type { ActivityResponse, ActivityRow, ActivitySource, DashboardResponse, Health } from "../../../src/adminapp/api-types";

const router = useRouter();
const days = ref<7 | 30 | 90>(30);
const dash = useFetch<DashboardResponse>(() => `/dashboard?days=${days.value}`);

// The feed: the dashboard's newest rows, or one category's from the activity list
type Feed = "all" | ActivityRow["category"];
const feed = ref<Feed>("all");
const feedRows = useFetch<ActivityResponse>(() => (feed.value === "all" ? null : `/activity?category=${feed.value}&limit=12`));
const latest = computed(() => (feed.value === "all" ? dash.data.value?.latest : feedRows.data.value?.rows) ?? null);

function reload() {
  dash.reload();
  if (feed.value !== "all") feedRows.reload();
}
onMounted(() => window.addEventListener("focus", reload));
onUnmounted(() => window.removeEventListener("focus", reload));

const SOURCES: ActivitySource[] = ["bot", "webapp", "companion"];
const UEX_STATE: Record<Health, string> = { ok: "OK", warn: "Late", err: "Stale" };
const LOGS_STATE: Record<Health, string> = { ok: "Working", warn: "Behind", err: "Stuck" };

const reach = computed(() => {
  const r = dash.data.value?.reach;
  if (!r) return [];
  return [
    { label: "Known users", count: r.known, to: "/users" },
    { label: "In an org", count: r.inOrg, to: "/orgs" },
    { label: "Holding data", count: r.holdingData, to: "/stock" },
    { label: "Web login, 30 d", count: r.webLogin30d, to: "/users" },
    { label: "Companion, 30 d", count: r.companion30d, to: "/users" },
  ].map((s) => ({ ...s, share: r.known ? s.count / r.known : 0 }));
});

const ORG_ROWS = 8;
const orgs = computed(() => (dash.data.value?.orgs ?? []).slice(0, ORG_ROWS));
const share = (part: number, whole: number) => (whole ? `${Math.round((part / whole) * 100)} %` : "—");
</script>

<template>
  <div class="view">
    <div class="stack scroll">
      <section class="panel">
        <div class="head">
          <Icon name="warning" :size="16" />
          <span class="head-title no-grow">Attention</span>
          <span v-if="dash.data.value?.attention.length" class="head-count">{{ dash.data.value.attention.length }}</span>
          <div class="spacer" />
          <span v-if="dash.data.value" class="head-count">checked {{ dateTime(dash.data.value.checkedAt) }}</span>
          <button type="button" class="btn outline small" @click="reload"><Icon name="refresh" :size="14" /> Refresh</button>
        </div>
        <div v-if="dash.error.value" class="empty-line">{{ dash.error.value }}</div>
        <div v-else-if="!dash.data.value" class="empty-line">Loading…</div>
        <div v-else-if="!dash.data.value.attention.length" class="pad all-good"><span class="tag ok"><Icon name="check" :size="12" /> All good</span></div>
        <div v-else class="pad pills">
          <RouterLink v-for="(a, i) in dash.data.value.attention" :key="i" :to="a.to" class="tag pill" :class="a.severity">
            <Icon name="warning" :size="12" /> {{ a.text }}
          </RouterLink>
        </div>
      </section>

      <template v-if="dash.data.value">
        <div class="kpis">
          <section class="panel kpi">
            <span class="panel-title">Active users · 7 d</span>
            <RouterLink to="/users" class="kpi-value">{{ dash.data.value.kpis.activeUsers.value.toLocaleString() }}</RouterLink>
            <span class="sub">of <RouterLink to="/users">{{ dash.data.value.kpis.activeUsers.known.toLocaleString() }}</RouterLink> known</span>
            <Sparkline :series="dash.data.value.kpis.activeUsers.series" unit="users" />
          </section>
          <section class="panel kpi">
            <span class="panel-title">Actions · 7 d</span>
            <RouterLink to="/activity?days=7" class="kpi-value">{{ dash.data.value.kpis.actions.value.toLocaleString() }}</RouterLink>
            <span class="sub">
              <template v-for="(s, i) in SOURCES" :key="s">
                <template v-if="i"> · </template>
                <RouterLink :to="`/activity?days=7&source=${s}`">{{ SOURCE_LABEL[s] }} {{ share(dash.data.value.kpis.actions.bySource[s], dash.data.value.kpis.actions.value) }}</RouterLink>
              </template>
            </span>
            <Sparkline :series="dash.data.value.kpis.actions.series" unit="actions" />
          </section>
          <section class="panel kpi">
            <span class="panel-title">Orgs with the bot</span>
            <RouterLink to="/orgs" class="kpi-value">{{ dash.data.value.kpis.orgs.withBot.toLocaleString() }}</RouterLink>
            <span class="sub">of {{ dash.data.value.kpis.orgs.total }} · {{ dash.data.value.kpis.orgs.activeMembers.toLocaleString() }} active members</span>
          </section>
          <section class="panel kpi">
            <span class="panel-title">Stored batches</span>
            <RouterLink to="/stock" class="kpi-value">{{ dash.data.value.kpis.stock.batches.toLocaleString() }}</RouterLink>
            <span class="sub">
              <span class="mono">{{ dash.data.value.kpis.stock.resourceScu }}</span> SCU ·
              <span class="mono">{{ dash.data.value.kpis.stock.itemPcs }}</span> pcs
              (<span class="mono">{{ dash.data.value.kpis.stock.gearPcs }}</span> gear)
            </span>
            <span class="sub">of {{ dash.data.value.kpis.stock.owners }} users</span>
          </section>
          <section class="panel kpi">
            <span class="panel-title">Refinery jobs running</span>
            <RouterLink to="/refinery" class="kpi-value">{{ dash.data.value.kpis.refinery.running.toLocaleString() }}</RouterLink>
            <span class="sub"><RouterLink to="/refinery">{{ dash.data.value.kpis.refinery.ready }}</RouterLink> ready to collect</span>
          </section>
          <section class="panel kpi">
            <span class="panel-title">Blueprints owned</span>
            <RouterLink to="/blueprints" class="kpi-value">{{ dash.data.value.kpis.blueprints.owned.toLocaleString() }}</RouterLink>
            <span class="sub">by <RouterLink to="/users">{{ dash.data.value.kpis.blueprints.users }}</RouterLink> users</span>
            <span class="sub">
              <RouterLink to="/activity?category=blueprint&action=add&source=companion">{{ dash.data.value.kpis.blueprints.viaCompanion }}</RouterLink>
              added via companion
            </span>
          </section>
        </div>

        <div class="row-2">
          <section class="panel grow-3">
            <div class="head">
              <Icon name="activity" :size="16" />
              <span class="head-title">Actions per day</span>
              <div class="chips">
                <button v-for="d in [7, 30, 90] as const" :key="d" type="button" class="chip" :class="{ active: days === d }" @click="days = d">{{ d }} d</button>
              </div>
            </div>
            <div class="pad"><DayBars :days="dash.data.value.perDay" /></div>
          </section>

          <section class="panel grow-2">
            <div class="head">
              <Icon name="history" :size="16" />
              <span class="head-title">Latest actions</span>
              <div class="chips">
                <button type="button" class="chip" :class="{ active: feed === 'all' }" @click="feed = 'all'">All</button>
                <button
                  v-for="c in (['stock', 'refinery', 'blueprint'] as const)"
                  :key="c"
                  type="button"
                  class="chip"
                  :class="{ active: feed === c }"
                  @click="feed = c"
                >{{ CATEGORY_LABEL[c] }}</button>
              </div>
            </div>
            <div v-if="feed !== 'all' && feedRows.error.value" class="empty-line">{{ feedRows.error.value }}</div>
            <div v-else-if="!latest" class="empty-line">Loading…</div>
            <div v-else-if="!latest.length" class="empty-line">No actions</div>
            <ul v-else class="feed">
              <li v-for="r in latest" :key="r.id">
                <span class="when faint" :title="dateTime(r.at)">{{ ago(r.at) }}</span>
                <span class="what">
                  <RouterLink :to="`/users/${r.actor.userId}`">{{ r.actor.name ?? r.actor.userId }}</RouterLink>
                  <span class="dim"> {{ r.action }} </span>
                  <span>{{ r.target }}</span>
                  <span v-if="amountText(r)" class="mono dim"> · {{ amountText(r) }}</span>
                  <template v-if="r.toOwner">
                    <span class="dim"> → </span><RouterLink :to="`/users/${r.toOwner.userId}`">{{ r.toOwner.name ?? r.toOwner.userId }}</RouterLink>
                  </template>
                  <template v-else-if="r.owner.userId !== r.actor.userId">
                    <span class="dim"> of </span><RouterLink :to="`/users/${r.owner.userId}`">{{ r.owner.name ?? r.owner.userId }}</RouterLink>
                  </template>
                  <template v-if="r.org">
                    <span class="dim"> in </span><RouterLink :to="`/orgs/${r.guildId}`">{{ r.org }}</RouterLink>
                  </template>
                </span>
                <span class="tag">{{ SOURCE_LABEL[r.source] }}</span>
              </li>
            </ul>
            <div class="foot">
              <RouterLink :to="feed === 'all' ? '/activity' : `/activity?category=${feed}`">All activity <Icon name="arrow-right" :size="12" /></RouterLink>
            </div>
          </section>
        </div>

        <div class="row-3">
          <section class="panel">
            <div class="head">
              <Icon name="users" :size="16" />
              <span class="head-title">Reach</span>
            </div>
            <div class="pad funnel">
              <RouterLink v-for="s in reach" :key="s.label" :to="s.to" class="step">
                <span class="step-label">{{ s.label }}</span>
                <span class="bar"><span class="fill" :style="{ width: `${s.share * 100}%` }" /></span>
                <span class="mono num">{{ s.count.toLocaleString() }}</span>
              </RouterLink>
            </div>
          </section>

          <section class="panel">
            <div class="head">
              <Icon name="users" :size="16" />
              <span class="head-title">Orgs</span>
              <RouterLink to="/orgs" class="head-count">all {{ dash.data.value.orgs.length }}</RouterLink>
            </div>
            <div v-if="!orgs.length" class="empty-line">No orgs</div>
            <table v-else class="mini">
              <thead><tr><th>Org</th><th class="num">Members</th><th class="num">Shared</th><th>Last action</th></tr></thead>
              <tbody>
                <tr v-for="o in orgs" :key="o.guildId" class="link" @click="router.push(`/orgs/${o.guildId}`)">
                  <td>{{ o.name }} <span v-if="!o.joinedAt || o.leftAt" class="tag">no bot</span></td>
                  <td class="num mono" :class="{ faint: !o.membersActive }">{{ o.membersActive }}</td>
                  <td class="num mono" :class="{ faint: !o.sharedBatches }">{{ o.sharedBatches }}</td>
                  <td :class="{ faint: !o.lastActivity }" :title="dateTime(o.lastActivity)">{{ o.lastActivity ? `${ago(o.lastActivity)} ago` : "—" }}</td>
                </tr>
              </tbody>
            </table>
          </section>

          <section class="panel">
            <div class="head">
              <Icon name="status" :size="16" />
              <span class="head-title">Sources</span>
              <RouterLink to="/status" class="head-count">Status</RouterLink>
            </div>
            <dl class="pad kv">
              <dt>Catalog</dt>
              <dd>
                <template v-if="dash.data.value.sources.game">
                  <RouterLink to="/imports" class="mono">{{ dash.data.value.sources.game.label ?? dash.data.value.sources.game.build }}</RouterLink>
                  <span class="faint"> · imported {{ ago(dash.data.value.sources.game.importedAt) }} ago</span>
                </template>
                <RouterLink v-else to="/imports" class="tag err">No import</RouterLink>
              </dd>
              <dt>UEX pull</dt>
              <dd>
                <RouterLink to="/status" class="tag" :class="dash.data.value.sources.uex.state ?? 'warn'">
                  {{ dash.data.value.sources.uex.state ? UEX_STATE[dash.data.value.sources.uex.state] : "No data" }}
                </RouterLink>
                <span v-if="dash.data.value.sources.uex.checkedAt" class="faint"> · checked {{ ago(dash.data.value.sources.uex.checkedAt) }} ago</span>
              </dd>
              <dt>Bot logs</dt>
              <dd>
                <RouterLink v-if="dash.data.value.sources.botLogs.state" to="/status" class="tag" :class="dash.data.value.sources.botLogs.state">
                  {{ LOGS_STATE[dash.data.value.sources.botLogs.state] }}
                </RouterLink>
                <span class="faint"> {{ dash.data.value.sources.botLogs.channels }} channels</span>
              </dd>
              <dt>History</dt>
              <dd>
                <RouterLink to="/activity" class="mono">{{ dash.data.value.sources.history.total.toLocaleString() }}</RouterLink> actions
                <span class="faint"> · newest {{ dash.data.value.sources.history.newestAt ? `${ago(dash.data.value.sources.history.newestAt)} ago` : "—" }}</span>
              </dd>
            </dl>
          </section>
        </div>
      </template>
    </div>
  </div>
</template>

<style scoped>
.scroll {
  overflow: auto;
}

.scroll > * {
  flex-shrink: 0;
}

.pad {
  padding: 12px 16px 14px;
}

.all-good {
  display: flex;
}

.pills {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.pill {
  height: 24px;
  font-size: 12px;
  text-decoration: none;
}

.pill:hover {
  text-decoration: none;
  filter: brightness(1.2);
}

.kpis {
  display: grid;
  grid-template-columns: repeat(6, minmax(0, 1fr));
  gap: 12px;
}

.kpi {
  gap: 4px;
  padding: 12px 14px;
  font-size: 12px;
}

.kpi-value {
  font-size: 28px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  color: var(--text);
  align-self: flex-start;
}

.kpi-value:hover {
  color: var(--accent);
  text-decoration: none;
}

.sub {
  color: var(--text-2);
}

.kpi .spark {
  margin-top: auto;
  padding-top: 6px;
}

.row-2 {
  display: flex;
  gap: 12px;
  align-items: stretch;
}

.grow-3 {
  flex: 3;
  min-width: 0;
}

.grow-2 {
  flex: 2;
  min-width: 0;
}

.feed {
  list-style: none;
  margin: 0;
  padding: 4px 0;
  font-size: 13px;
}

.feed li {
  display: flex;
  align-items: baseline;
  gap: 10px;
  padding: 5px 16px;
}

.when {
  width: 44px;
  flex-shrink: 0;
  font-size: 12px;
}

.what {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.foot {
  margin-top: auto;
  padding: 8px 16px 12px;
  font-size: 12px;
}

.foot a {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}

.row-3 {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 12px;
  align-items: start;
}

.funnel {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.step {
  display: grid;
  grid-template-columns: 120px minmax(0, 1fr) 48px;
  align-items: center;
  gap: 10px;
  font-size: 13px;
  color: var(--text);
}

.step:hover {
  text-decoration: none;
}

.step:hover .step-label {
  color: var(--accent);
}

.step-label {
  color: var(--text-2);
}

.bar {
  height: 10px;
  border-radius: 2px;
  background: var(--bg-surface-2);
  overflow: hidden;
}

.fill {
  display: block;
  height: 100%;
  background: var(--accent);
}

.num {
  text-align: right;
}

.kv a.tag:hover {
  text-decoration: none;
}
</style>
