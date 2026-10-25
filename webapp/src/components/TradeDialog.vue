<script setup lang="ts">
// Where a material trades (GET /api/trade/:uuid): the terminal tables (TradeTables) in a dialog,
// UEX's averages in the head.
import { computed, ref } from "vue";
import type { TradeResponse } from "../../../src/webapp/api-types";
import { api } from "../api";
import { t } from "../i18n";
import { toastError } from "../toasts";
import ConfirmDialog, { type ConfirmButton } from "./ConfirmDialog.vue";
import TradeTables, { averagesText } from "./TradeTables.vue";

const props = defineProps<{ uuid: string; name: string }>();
const emit = defineEmits<{ close: [] }>();

const data = ref<TradeResponse | null>(null);

void api<TradeResponse>(`/trade/${props.uuid}`).then((r) => {
  data.value = r;
}).catch((e: unknown) => {
  toastError(e);
  emit("close");
});

const averages = computed(() => averagesText(data.value?.prices));

const buttons = computed<ConfirmButton[]>(() => [{ label: t("common.close"), kind: "outline", value: "close" }]);
</script>

<template>
  <ConfirmDialog :title="name" :subtitle="t('trade.button')" icon="list" :buttons="buttons" xl @choose="emit('close')">
    <template #head><span class="averages">{{ averages }}</span></template>
    <div v-if="!data" class="empty-line">{{ t("common.loading") }}</div>
    <TradeTables v-else :data="data" />
  </ConfirmDialog>
</template>

<style scoped>
.averages {
  font-size: 12px;
  color: var(--text-2);
  white-space: nowrap;
}
</style>
