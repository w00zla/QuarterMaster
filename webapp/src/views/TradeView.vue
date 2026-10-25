<script lang="ts">
import { ref } from "vue";

// The pick (a material or gear item), kept for the session
const tradePick = ref<string | null>(null);
</script>

<script setup lang="ts">
// Handel: pick a material or gear item with a UEX price (GET /api/trade/prices, per visit), see where it
// trades (GET /api/trade/:uuid). Names from the catalog, so the list follows the language.
import { computed, watch } from "vue";
import type { TradePricesResponse, TradeResponse } from "../../../src/webapp/api-types";
import Icon from "../../../adminapp/src/components/Icon.vue";
import { api } from "../api";
import { catalog } from "../catalog";
import Picker from "../components/Picker.vue";
import TradeTables, { averagesText } from "../components/TradeTables.vue";
import { lang, t } from "../i18n";
import { toastError } from "../toasts";

const priced = ref<Set<string> | null>(null);
const result = ref<TradeResponse | null>(null);

void api<TradePricesResponse>("/trade/prices").then((r) => {
  priced.value = new Set(Object.keys(r.prices));
}).catch(toastError);

// Components by their unique label, the rest by name (label = name there)
const options = computed(() => (catalog.value?.materials ?? []).filter((m) => priced.value?.has(m.uuid))
  .map((m) => ({ value: m.uuid, label: m.label })).sort((a, b) => a.label.localeCompare(b.label, lang.value)));

let seq = 0;
watch(tradePick, async () => {
  const mine = ++seq;
  result.value = null;
  if (!tradePick.value) return;
  try {
    const r = await api<TradeResponse>(`/trade/${tradePick.value}`);
    if (mine === seq) result.value = r;
  } catch (e) {
    if (mine === seq) toastError(e);
  }
}, { immediate: true });

const averages = computed(() => averagesText(result.value?.prices));
</script>

<template>
  <div class="page">
    <section class="panel unclipped">
      <div class="head">
        <Icon name="trade" :size="16" />
        <span class="head-title no-grow">{{ t("trade.title") }}</span>
        <div class="spacer" />
      </div>

      <section class="section">
        <div class="section-bar">
          <Icon name="list" :size="14" />
          <span class="panel-title">{{ t("trade.prices") }}</span>
          <div class="divider bar-divider" />
          <Picker v-model="tradePick" class="section-picker" :options="options" :placeholder="t('trade.pick')" strong />
          <span v-if="averages" class="averages">{{ averages }}</span>
        </div>
        <div v-if="!tradePick" class="empty-line">{{ t("trade.empty") }}</div>
        <div v-else-if="!result" class="empty-line">{{ t("common.loading") }}</div>
        <TradeTables v-else :data="result" />
      </section>
    </section>
  </div>
</template>

<style scoped>
.section {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 16px;
}

.section-bar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  padding-bottom: 8px;
  border-bottom: 1px solid var(--border-dim);
}

.section-picker {
  width: 320px;
  max-width: 100%;
}

.averages {
  margin-left: auto;
  font-size: 12px;
  color: var(--text-2);
  white-space: nowrap;
}

/* Phones: the picker gets a row of its own below the label */
@media (max-width: 640px) {
  .bar-divider {
    display: none;
  }

  .section-picker {
    flex-basis: 100%;
    width: auto;
  }
}
</style>
