<script setup lang="ts">
// Refinery: your running jobs (personal batches in state refining), start one, finish one. Jobs are
// always personal, so this works the same without any org.
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import type { StockBatch, StockListResponse } from "../../../src/webapp/api-types";
import Icon from "../../../adminapp/src/components/Icon.vue";
import { api } from "../api";
import BatchDialog from "../components/BatchDialog.vue";
import ConfirmDialog, { type ConfirmButton } from "../components/ConfirmDialog.vue";
import StockAddForm from "../components/StockAddForm.vue";
import { compareBatches, qty } from "../format";
import { lang, t } from "../i18n";
import { onServerMessage } from "../realtime";
import { toastError } from "../toasts";

const data = ref<StockListResponse | null>(null);
// "Start job" as a dialog: the form, then its own confirmation
const showStart = ref(false);
const startButtons = computed<ConfirmButton[]>(() => [{ label: t("common.cancel"), kind: "outline", value: "cancel" }]);

function started() {
  showStart.value = false;
  void load();
}
const finishing = ref<StockBatch | null>(null);

let seq = 0;
async function load() {
  const mine = ++seq;
  try {
    const r = await api<StockListResponse>(`/stock?scope=personal&lang=${lang.value}`);
    if (mine === seq) data.value = r;
  } catch (e) {
    if (mine === seq) toastError(e);
  }
}

const jobs = computed(() => (data.value?.batches ?? []).filter((b) => b.state === "refining")
  .sort((a, b) => a.material.localeCompare(b.material, lang.value) || compareBatches(a, b)));

watch(lang, load);

let unsubscribe = () => {};
onMounted(() => {
  void load();
  unsubscribe = onServerMessage((m) => {
    if (m.type === "resync" || (m.type === "stock" && m.scope === "personal")) void load();
  });
});
onUnmounted(() => unsubscribe());
</script>

<template>
  <div class="page">
    <section class="panel">
      <div class="head">
        <Icon name="drop" :size="16" />
        <span class="head-title">{{ t("refinery.jobs") }}</span>
        <button type="button" class="btn small primary" @click="showStart = true">
          <Icon name="plus" :size="14" /> {{ t("refinery.start") }}
        </button>
      </div>
      <div v-if="!data" class="empty-line">{{ t("common.loading") }}</div>
      <div v-else-if="!jobs.length" class="empty-line">{{ t("refinery.none") }}</div>
      <div v-for="b in jobs" :key="b.id" class="list-row">
        <span class="job-name">{{ b.material }}</span>
        <span class="q">Q{{ b.quality }}</span>
        <span class="amount">{{ qty(b.quantity, b.unit) }}</span>
        <span class="dim">{{ b.location }}</span>
        <span class="row-actions">
          <button type="button" class="btn small primary" @click="finishing = b"><Icon name="check" :size="14" /> {{ t("refinery.done") }}</button>
        </span>
      </div>
    </section>

    <ConfirmDialog v-if="showStart" :title="t('refinery.start')" icon="drop" :buttons="startButtons" @choose="showStart = false">
      <StockAddForm refinery class="flush" @done="started" />
    </ConfirmDialog>

    <BatchDialog v-if="finishing" :key="finishing.id" :batch="finishing" action="done" @close="finishing = null" @done="load" />
  </div>
</template>

<style scoped>
.job-name {
  font-weight: 600;
}
</style>
