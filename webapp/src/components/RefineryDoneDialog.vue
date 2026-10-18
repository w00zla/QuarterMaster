<script setup lang="ts">
// Finishes a refinery job (POST /api/refinery/done): the whole work order at once, as the game hands it
// out, stored at the station. One line per material: the amount received (starting from the expected
// yield, which the user corrects to what the game shows; "0" when nothing came out); the quality stays.
// Two steps like every change of existing stock: the inputs, then a summary to confirm.
import { computed, reactive, ref } from "vue";
import type { OkResponse, RefineryDoneRequest, StockBatch } from "../../../src/webapp/api-types";
import { api } from "../api";
import { amountOf, qText, qty } from "../format";
import { t } from "../i18n";
import { toast, toastError } from "../toasts";
import AmountStepper from "./AmountStepper.vue";
import ConfirmDialog, { type ConfirmButton } from "./ConfirmDialog.vue";

const props = defineProps<{ batches: StockBatch[] }>();
const emit = defineEmits<{ close: []; done: [] }>();

const first = props.batches[0]!;
const step = ref<"input" | "confirm">("input");
const busy = ref(false);
const lines = reactive(props.batches.map((b) => ({ batch: b, amount: b.quantity })));

// "0" is allowed here: a tiny row may yield nothing
const amt = (text: string) => (/^\s*0+([.,]0*)?\s*$/.test(text) ? "0" : amountOf(text, "SCU"));
const valid = computed(() => lines.every((l) => amt(l.amount) !== null));

const buttons = computed<ConfirmButton[]>(() => step.value === "input"
  ? [
      { label: t("common.cancel"), kind: "outline", value: "cancel" },
      { label: t("common.continue"), kind: "primary", value: "next", disabled: !valid.value },
    ]
  : [
      { label: t("common.cancel"), kind: "outline", value: "cancel" },
      { label: t("common.back"), kind: "outline", value: "back", side: "left" },
      { label: t("refinery.store"), kind: "primary", value: "confirm", disabled: busy.value },
    ]);

function choose(value: string) {
  if (value === "cancel") emit("close");
  else if (value === "back") step.value = "input";
  else if (value === "next" && valid.value) step.value = "confirm";
  else if (value === "confirm") void book();
}

function onEnter(e: KeyboardEvent) {
  if (e.defaultPrevented || step.value !== "input") return;
  e.preventDefault();
  choose("next");
}

async function book() {
  if (busy.value) return;
  busy.value = true;
  try {
    const body: RefineryDoneRequest = {
      jobId: first.refine!.jobId,
      rows: lines.map((l) => ({ batchId: l.batch.id, amount: amt(l.amount)!, expected: l.batch.quantity })),
    };
    await api<OkResponse>("/refinery/done", { method: "POST", body });
    const what = lines.map((l) => `${l.batch.material} → ${qty(amt(l.amount)!, "SCU")} · ${qText(l.batch.quality)}`).join(", ");
    toast(t("refinery.finished", { what: `${what} · ${first.location}` }));
    emit("done");
    emit("close");
  } catch (e) {
    toastError(e);
    // Refused because the job changed meanwhile: what is shown is outdated, close (the list reloads)
    if (e instanceof Error && (e.message === "batchChanged" || e.message === "batchNotFound")) emit("close");
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <ConfirmDialog
    :title="step === 'input' ? t('refinery.doneTitle') : t('common.checkTitle')"
    :subtitle="first.location"
    icon="check"
    :buttons="buttons"
    @choose="choose"
  >
    <div v-if="step === 'input'" class="done-lines" @keydown.enter="onEnter">
      <span class="field">{{ t("field.material") }}</span>
      <span class="field">{{ t("refinery.col.received") }}</span>
      <template v-for="l in lines" :key="l.batch.id">
        <span class="material">{{ l.batch.material }} · {{ qText(l.batch.quality) }} · {{ qty(l.batch.quantity, l.batch.unit) }}</span>
        <!-- "0": nothing came out -->
        <AmountStepper v-model="l.amount" unit="SCU" :min="0" :invalid="l.amount.trim() !== '' && amt(l.amount) === null" :label="t('refinery.col.received')" />
      </template>
    </div>

    <div v-else class="summary">
      <span v-for="l in lines" :key="l.batch.id">
        <span class="dim">{{ l.batch.material }} · {{ qty(l.batch.quantity, l.batch.unit) }} →</span>
        {{ qty(amt(l.amount) ?? "", "SCU") }} · {{ qText(l.batch.quality) }}
      </span>
      <span><span class="dim">{{ t("refinery.storedAt") }}:</span> {{ first.location }} · {{ t("stock.pers") }}</span>
    </div>
  </ConfirmDialog>
</template>

<style scoped>
.done-lines {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 8px 12px;
  align-items: center;
}

.material {
  font-size: 13px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
