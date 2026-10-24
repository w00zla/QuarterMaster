<script setup lang="ts">
// Where a resource of the crafting check is mined (GET /api/mining/:uuid): its ores, or the gem rock for an item;
// against the card's target quality (changeable here, not written back).
import { onMounted, ref } from "vue";
import type { MiningResponse } from "../../../src/webapp/api-types";
import { api } from "../api";
import { lang, t } from "../i18n";
import { toastError } from "../toasts";
import ConfirmDialog, { type ConfirmButton } from "./ConfirmDialog.vue";
import MiningTable from "./MiningTable.vue";

const props = defineProps<{ uuid: string; name: string; target: number }>();
const emit = defineEmits<{ close: [] }>();

const buttons: ConfirmButton[] = [{ label: t("common.close"), kind: "outline", value: "close" }];
const data = ref<MiningResponse | null>(null);
const target = ref<number | null>(props.target);

onMounted(async () => {
  try {
    data.value = await api<MiningResponse>(`/mining/${props.uuid}?lang=${lang.value}`);
  } catch (e) {
    toastError(e);
    emit("close");
  }
});
</script>

<template>
  <ConfirmDialog :title="name" :subtitle="t('mining.open')" icon="pickaxe" :buttons="buttons" xxl @choose="emit('close')">
    <div v-if="!data" class="empty-line">{{ t("common.loading") }}</div>
    <MiningTable v-else v-model:target="target" :rows="data.rows" />
  </ConfirmDialog>
</template>
