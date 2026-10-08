<script setup lang="ts">
// Start page: headline numbers for your personal stock and each org, then your orgs (also fine
// without any org). The numbers reload on every change the realtime channel announces.
import { computed, onMounted, onUnmounted, ref } from "vue";
import type { StockMetrics, SummaryResponse } from "../../../src/webapp/api-types";
import { api } from "../api";
import Icon from "../../../adminapp/src/components/Icon.vue";
import StatTile from "../components/StatTile.vue";
import { hm } from "../format";
import { lang, t } from "../i18n";
import { coalesced, onServerMessage } from "../realtime";
import { me } from "../session";
import { toastError } from "../toasts";

const summary = ref<SummaryResponse | null>(null);
let loading = false;
let again = false;

async function load() {
  if (loading) {
    again = true;
    return;
  }
  loading = true;
  try {
    do {
      again = false;
      summary.value = await api<SummaryResponse>("/summary");
    } while (again);
  } catch (e) {
    toastError(e);
  } finally {
    loading = false;
  }
}

const number = (value: string | number | undefined, digits = 0) =>
  value === undefined ? null : new Intl.NumberFormat(lang.value, { maximumFractionDigits: digits }).format(Number(value));
const orgStats = (guildId: string) => summary.value?.orgs.find((o) => o.guildId === guildId);
// "1 location", "3 locations"
const count = (n: number, one: "sum.kind" | "sum.location", many: "sum.kinds" | "sum.locations") => t(n === 1 ? one : many, { n: number(n)! });
const kindsAndLocations = (m: { kinds: number; locations: number } | undefined) =>
  m ? `${count(m.kinds, "sum.kind", "sum.kinds")} · ${count(m.locations, "sum.location", "sum.locations")}` : "";
const stockTiles = (s: StockMetrics | undefined) => [
  { label: t("sum.resources"), value: number(s?.resources.scu, 2), unit: "SCU", sub: kindsAndLocations(s?.resources), icon: "resource" as const },
  { label: t("sum.items"), value: number(s?.items.pieces), unit: t("unit.pcs"), sub: kindsAndLocations(s?.items), icon: "item" as const },
];
const blueprintsOf = (n: number | undefined) => ({ value: number(n), unit: `/ ${number(summary.value?.obtainableBlueprints)}` });

const refining = computed(() => summary.value?.personal.refining);
const refiningSub = computed(() => {
  const r = refining.value;
  if (!r) return "";
  const amount = r.expected === null ? "—" : `${number(r.expected, 2)} SCU`;
  return `${t("sum.yield", { v: amount })} · ${count(r.locations, "sum.location", "sum.locations")}`;
});
// The countdown runs on its own; the summary itself only reloads on changes
const now = ref(Date.now());
let tick: ReturnType<typeof setInterval> | undefined;
const nextEnd = computed(() => refining.value?.endsAt.map(Date.parse).find((e) => e > now.value));
const readyJobs = computed(() => refining.value?.endsAt.filter((e) => Date.parse(e) <= now.value).length ?? 0);

const reload = coalesced(() => void load());
let unsubscribe = () => {};
onMounted(() => {
  tick = setInterval(() => (now.value = Date.now()), 30_000);
  void load();
  unsubscribe = onServerMessage(() => reload.schedule());
});
onUnmounted(() => {
  unsubscribe();
  reload.cancel();
  clearInterval(tick);
});
</script>

<template>
  <div v-if="me" class="home">
    <section class="panel">
      <div class="head">
        <Icon name="user" :size="16" />
        <span class="head-title">{{ t("stock.personal") }}</span>
      </div>
      <div class="stats">
        <StatTile v-for="tile in stockTiles(summary?.personal)" :key="tile.label" :label="tile.label" :value="tile.value" :unit="tile.unit" :icon="tile.icon">{{ tile.sub }}</StatTile>
        <StatTile icon="blueprint" :label="t('sum.blueprints')" v-bind="blueprintsOf(summary?.personal.blueprints)" />
        <StatTile icon="drop" :label="t('sum.refining')" :value="number(refining?.jobs)">{{ refiningSub }}</StatTile>
        <StatTile icon="clock" subtle :label="t('sum.nextReady')" :value="nextEnd === undefined ? null : hm((nextEnd - now) / 1000)">
          <span v-if="readyJobs" class="tag ok">{{ t("sum.readyCount", { n: readyJobs }) }}</span>
        </StatTile>
      </div>
    </section>
    <section class="panel">
      <div class="head">
        <Icon name="users" :size="16" />
        <span class="head-title">{{ t("home.orgs") }}</span>
      </div>
      <div v-if="!me.orgs.length" class="empty-line">{{ t("home.noOrgs") }}</div>
      <div v-else class="orgs">
        <div v-for="o in me.orgs" :key="o.guildId" class="org">
          <div class="org-head">
            <span class="org-name">{{ o.name }}</span>
            <span v-if="!o.botPresent" class="warning" :title="t('home.botMissingHint')"><Icon name="warning" :size="14" /> {{ t("home.botMissing") }}</span>
            <span v-else-if="!o.rosterFresh" class="warning" :title="t('home.rosterStale')"><Icon name="warning" :size="14" /> {{ t("home.readOnly") }}</span>
            <span class="spacer" />
            <span class="role members" :class="{ officer: o.officer }">{{ t("home.members", { n: number(orgStats(o.guildId)?.members) ?? "—" }) }}</span>
            <span class="role" :class="{ officer: o.officer }">{{ t("home.role", { role: t(o.officer ? "home.officer" : "home.member") }) }}</span>
          </div>
          <div class="stats">
            <StatTile v-for="tile in stockTiles(orgStats(o.guildId))" :key="tile.label" :label="tile.label" :value="tile.value" :unit="tile.unit" :icon="tile.icon">{{ tile.sub }}</StatTile>
            <StatTile icon="blueprint" :label="t('sum.blueprints')" v-bind="blueprintsOf(orgStats(o.guildId)?.blueprints)" />
          </div>
        </div>
      </div>
    </section>
  </div>
</template>

<style scoped>
.home {
  display: flex;
  flex-direction: column;
  gap: 12px;
  max-width: 1280px;
  /* Centred like the other views */
  margin: 0 auto;
  width: 100%;
}

.stats {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
  gap: 8px;
  padding: 12px 16px 16px;
}

.orgs {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 12px 16px 16px;
}

/* One org as a tile inside the panel: name, state and role, then its numbers */
.org {
  border: 1px solid var(--border-dim);
  border-radius: var(--radius-panel);
}

.org-head {
  display: flex;
  align-items: center;
  gap: 10px;
  min-height: 44px;
  padding: 0 14px;
  border-bottom: 1px solid var(--border-dim);
}

.org .stats {
  padding: 12px 14px 14px;
}

.org-name {
  font-weight: 600;
}

.role {
  font-size: 12px;
  color: var(--text-2);
}

.members {
  margin-right: 8px;
}

.role.officer {
  color: var(--accent);
}
</style>
