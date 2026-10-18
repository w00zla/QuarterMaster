<script setup lang="ts">
// Starts a refinery job (POST /api/refinery/start): a work order at one refinery with one time, and one
// row per refined material (and quality) with its expected yield, as the terminal lists them (ores are
// not booked). The duration may stay empty (the end stays open, set later in the list). Books right away;
// the toast says what was started.
import { computed, reactive, ref } from "vue";
import type { OkResponse, RefineryStartRequest } from "../../../src/webapp/api-types";
import Icon from "../../../adminapp/src/components/Icon.vue";
import { api } from "../api";
import { locations, materials, refineryLocationOptions, resourceOptions, yieldBonus } from "../catalog";
import { amountOf, durationOfParts, hm, qty, qualityOf } from "../format";
import { t } from "../i18n";
import { toast, toastError } from "../toasts";
import AmountStepper from "./AmountStepper.vue";
import Picker from "./Picker.vue";

const emit = defineEmits<{ done: [] }>();

interface MaterialRow {
  id: number;
  material: string | null;
  quality: string;
  // Expected yield in SCU
  amount: string;
}

let nextId = 0;
// A new row starts at 1 SCU, like the stock add form
const newRow = (): MaterialRow => ({ id: nextId++, material: null, quality: "", amount: "1" });

const location = ref<string | null>(null);
const hours = ref("");
const minutes = ref("");
const seconds = ref("");
const rows = reactive<MaterialRow[]>([newRow()]);
const busy = ref(false);

// The refinery picker carries the UEX bonus of the first material picked
const refineryOptions = computed(() => refineryLocationOptions.value.map((o) => {
  const bonus = yieldBonus(o.value, rows.find((r) => r.material)?.material ?? null);
  return bonus ? { ...o, label: `${o.label} · ${bonus}` } : o;
}));

const amt = (r: MaterialRow) => amountOf(r.amount, "SCU");
const q = (r: MaterialRow) => qualityOf(r.quality);

// The processing time; all fields empty = none (the end stays open, it can be set later in the list)
const durationSeconds = computed(() => durationOfParts(hours.value, minutes.value, seconds.value));

const rowValid = (r: MaterialRow) => !!r.material && q(r) !== null && !!amt(r);
const valid = computed(() => !!location.value && durationSeconds.value !== null && rows.length > 0 && rows.every(rowValid));

function addRow() {
  rows.push(newRow());
}

function removeRow(id: number) {
  const i = rows.findIndex((r) => r.id === id);
  if (i >= 0) rows.splice(i, 1);
  if (!rows.length) rows.push(newRow());
}

// Back to an empty form
function clear() {
  location.value = null;
  hours.value = "";
  minutes.value = "";
  seconds.value = "";
  rows.splice(0, rows.length, newRow());
}

async function submit() {
  if (!valid.value || busy.value) return;
  const yields = rows.map((r) => `${qty(amt(r)!, "SCU")} ${materials.value.get(r.material!)?.name ?? ""}`).join(", ");
  const time = durationSeconds.value === undefined ? t("refinery.durationOpen") : hm(durationSeconds.value!);
  const what = `${yields} · ${locations.value.get(location.value!)?.short ?? ""} · ${time}`;
  busy.value = true;
  try {
    const body: RefineryStartRequest = {
      locationUuid: location.value!,
      ...(durationSeconds.value === undefined ? {} : { durationSeconds: durationSeconds.value! }),
      rows: rows.map((r) => ({ resourceUuid: r.material!, quality: q(r)!, amount: r.amount.trim() })),
    };
    await api<OkResponse>("/refinery/start", { method: "POST", body });
    toast(t("refinery.started", { what }));
    clear();
    emit("done");
  } catch (e) {
    toastError(e);
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <form class="form" @submit.prevent="submit">
    <label class="field">
      {{ t("field.location") }}
      <Picker v-model="location" :options="refineryOptions" :placeholder="t('pick.location')" />
    </label>
    <div class="field">
      {{ t("field.duration") }}
      <span class="with-unit">
        <input v-model="hours" class="input short" :class="{ invalid: durationSeconds === null }" type="text" inputmode="numeric" />
        <span class="unit">{{ t("time.h") }}</span>
        <input v-model="minutes" class="input short" :class="{ invalid: durationSeconds === null }" type="text" inputmode="numeric" />
        <span class="unit">{{ t("time.m") }}</span>
        <input v-model="seconds" class="input short" :class="{ invalid: durationSeconds === null }" type="text" inputmode="numeric" />
        <span class="unit">{{ t("time.s") }}</span>
      </span>
    </div>

    <div class="material-rows">
      <span class="field">{{ t("field.material") }}</span>
      <span class="field">{{ t("field.quality") }}</span>
      <span class="field">{{ t("field.expectedYield") }}</span>
      <span />
      <template v-for="r in rows" :key="r.id">
        <Picker v-model="r.material" :options="resourceOptions" :placeholder="t('pick.material')" />
        <input v-model="r.quality" class="input" :class="{ invalid: r.quality.trim() !== '' && q(r) === null }" type="text" inputmode="numeric" placeholder="0–1000" />
        <AmountStepper v-model="r.amount" unit="SCU" :invalid="r.amount.trim() !== '' && !amt(r)" :label="t('field.expectedYield')" />
        <button type="button" class="icon-btn" :title="t('refinery.removeRow')" @click="removeRow(r.id)"><Icon name="trash" :size="14" /></button>
      </template>
    </div>

    <div class="form-actions">
      <button type="button" class="btn outline add-row" @click="addRow"><Icon name="plus" :size="14" /> {{ t("refinery.addRow") }}</button>
      <button type="button" class="btn outline" @click="clear"><Icon name="close" :size="14" /> {{ t("common.clear") }}</button>
      <button type="submit" class="btn primary" :disabled="!valid || busy">
        <Icon name="plus" :size="14" /> {{ t("refinery.start") }}
      </button>
    </div>
  </form>
</template>

<style scoped>
/* The materials of the job: one line each, the column names once above them */
.material-rows {
  grid-column: 1 / -1;
  display: grid;
  grid-template-columns: minmax(260px, 3fr) minmax(90px, 1fr) auto 32px;
  gap: 8px 12px;
  align-items: center;
}

/* "Add material" sits on the left, the form's own buttons on the right */
.add-row {
  margin-right: auto;
}
</style>
