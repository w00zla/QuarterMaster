<script setup lang="ts">
// Start page: headline numbers for your personal stock and each org, then your orgs (also fine
// without any org). The numbers reload on every change the realtime channel announces.
import { onMounted, onUnmounted, ref } from "vue";
import type { StockMetrics, SummaryResponse } from "../../../src/webapp/api-types";
import { api } from "../api";
import Icon from "../../../web/src/components/Icon.vue";
import StatTile from "../components/StatTile.vue";
import { lang, t } from "../i18n";
import { onServerMessage } from "../realtime";
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
const stockTiles = (s: StockMetrics | undefined) => [
  { label: t("sum.materials"), value: number(s?.materials), icon: "resource" as const },
  { label: t("sum.scu"), value: number(s?.scu, 2), icon: "type-crate" as const },
  { label: t("sum.pieces"), value: number(s?.pieces), icon: "item" as const },
];

let unsubscribe = () => {};
onMounted(() => {
  void load();
  unsubscribe = onServerMessage(() => void load());
});
onUnmounted(() => unsubscribe());
</script>

<template>
  <div v-if="me" class="home">
    <section class="panel">
      <div class="head">
        <Icon name="user" :size="16" />
        <span class="head-title">{{ t("stock.personal") }}</span>
      </div>
      <div class="stats">
        <StatTile v-for="tile in stockTiles(summary?.personal)" :key="tile.label" :label="tile.label" :value="tile.value" :icon="tile.icon" />
        <StatTile icon="drop" :label="t('sum.refining')" :value="number(summary?.personal.refiningJobs)" />
        <StatTile icon="blueprint" :label="t('sum.blueprints')" :value="number(summary?.personal.blueprints)" />
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
            <span class="role" :class="{ officer: o.officer }">{{ t("home.role", { role: t(o.officer ? "home.officer" : "home.member") }) }}</span>
          </div>
          <div class="stats">
            <StatTile icon="users" :label="t('sum.members')" :value="number(orgStats(o.guildId)?.members)" />
            <StatTile v-for="tile in stockTiles(orgStats(o.guildId))" :key="tile.label" :label="tile.label" :value="tile.value" :icon="tile.icon" />
            <StatTile icon="blueprint" :label="t('sum.blueprints')" :value="number(orgStats(o.guildId)?.blueprints)" />
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

.role.officer {
  color: var(--accent);
}
</style>
