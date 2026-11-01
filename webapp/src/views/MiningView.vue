<script setup lang="ts">
// Bergbau: pick an ore, raw material or gem (GET /api/mining), see where it is mined (GET /api/mining/:uuid).
// The pick stays for the session; the list follows the language.
import { computed, ref, watch } from "vue";
import type { MiningIndexResponse, MiningResource, MiningResponse } from "../../../src/webapp/api-types";
import Icon from "../../../adminapp/src/components/Icon.vue";
import { api } from "../api";
import Dropdown from "../components/Dropdown.vue";
import MiningTable from "../components/MiningTable.vue";
import Picker from "../components/Picker.vue";
import { lang, t } from "../i18n";
import { methodOptions, miningFilter, miningPick, systemOptions } from "../mining";
import { toastError } from "../toasts";

const resources = ref<MiningResource[] | null>(null);
const result = ref<MiningResponse | null>(null);

watch(lang, async () => {
  try {
    resources.value = (await api<MiningIndexResponse>(`/mining?lang=${lang.value}`)).resources;
  } catch (e) {
    toastError(e);
  }
}, { immediate: true });

// The ore with what it refines into (searched too)
const options = computed(() => (resources.value ?? []).map((r) => ({ value: r.uuid, label: r.name, hint: r.refined ?? undefined })));

let seq = 0;
watch([miningPick, lang], async () => {
  const mine = ++seq;
  result.value = null;
  if (!miningPick.value) return;
  try {
    const r = await api<MiningResponse>(`/mining/${miningPick.value}?lang=${lang.value}`);
    if (mine === seq) result.value = r;
  } catch (e) {
    if (mine === seq) toastError(e);
  }
}, { immediate: true });
</script>

<template>
  <div class="page">
    <section class="panel unclipped">
      <div class="head">
        <Icon name="pickaxe" :size="16" />
        <span class="head-title no-grow">{{ t("mining.title") }}</span>
        <div class="spacer" />
      </div>

      <!-- One section per mining feature; the first: where something is mined -->
      <section class="section">
        <div class="section-bar">
          <Icon name="locate" :size="14" />
          <span class="panel-title">{{ t("mining.open") }}</span>
          <div class="divider bar-divider" />
          <Picker v-model="miningPick" class="section-picker" :options="options" :placeholder="t('mining.pick')" strong />
          <!-- The table's filters right of the picker (the dialog keeps them in the table's toolbar) -->
          <Dropdown v-model="miningFilter.system" variant="chip" :options="systemOptions()" />
          <Dropdown v-model="miningFilter.method" variant="chip" :options="methodOptions()" />
        </div>
        <div v-if="!miningPick" class="empty-line">{{ t("mining.empty") }}</div>
        <div v-else-if="!result" class="empty-line">{{ t("common.loading") }}</div>
        <MiningTable v-else :rows="result.rows" filters-outside />
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
