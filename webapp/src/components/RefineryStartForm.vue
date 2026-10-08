<script setup lang="ts">
// Starts a refinery job (POST /api/refinery/start): a work order at one refinery with one method and
// time, and one row per ore (and quality) as the terminal lists them. Duration and expected yields are
// prefilled from the method's community values (and the station's UEX bonus per ore) until the user
// types into them, e.g. the terminal's numbers. Books right away; the toast says what was started.
import { computed, reactive, ref, watch } from "vue";
import { estimateJob } from "../../../src/ext/refining-estimate";
import type { OkResponse, RefineryStartRequest } from "../../../src/webapp/api-types";
import Icon from "../../../adminapp/src/components/Icon.vue";
import { api } from "../api";
import { locations, materials, methods, oreOptions, refineryLocationOptions, yieldBonus, yieldValue } from "../catalog";
import { amountOf, hm, qty, qualityOf, unitText } from "../format";
import { t } from "../i18n";
import { toast, toastError } from "../toasts";
import Dropdown from "./Dropdown.vue";
import Picker from "./Picker.vue";

const emit = defineEmits<{ done: [] }>();

interface OreRow {
  id: number;
  ore: string | null;
  quality: string;
  amount: string;
  expectedYield: string;
  yieldEdited: boolean;
}

let nextId = 0;
const newRow = (): OreRow => ({ id: nextId++, ore: null, quality: "", amount: "", expectedYield: "", yieldEdited: false });

const location = ref<string | null>(null);
const method = ref("");
const hours = ref("");
const minutes = ref("");
const durationEdited = ref(false);
const rows = reactive<OreRow[]>([newRow()]);
const busy = ref(false);

const methodOptions = computed(() => [...methods.value.values()].map((m) => ({ value: m.code, label: `${m.name} · ${m.yieldPct} %` })));
watch(methodOptions, (o) => {
  if (!method.value && o.length) method.value = o[0]!.value;
}, { immediate: true });

// The refinery picker carries the UEX bonus of the first ore picked
const refineryOptions = computed(() => refineryLocationOptions.value.map((o) => {
  const bonus = yieldBonus(o.value, rows.find((r) => r.ore)?.ore ?? null);
  return bonus ? { ...o, label: `${o.label} · ${bonus}` } : o;
}));

const amt = (r: OreRow) => amountOf(r.amount, "SCU");
const q = (r: OreRow) => qualityOf(r.quality);
// "" = no estimate given; null = invalid
const expectedAmt = (r: OreRow) => {
  const text = r.expectedYield.trim();
  if (!text) return "";
  return /^0+([.,]0*)?$/.test(text) ? "0" : amountOf(text, "SCU");
};

function rowEstimate(r: OreRow) {
  const m = methods.value.get(method.value);
  const a = amt(r);
  if (!m || !a) return null;
  return estimateJob(Number(a), m, (location.value && yieldValue(location.value, r.ore)) || 0);
}

// The job's time comes from the whole load
const totalScu = computed(() => rows.reduce((sum, r) => sum + Number(amt(r) ?? 0), 0));
watch([totalScu, method], () => {
  const m = methods.value.get(method.value);
  if (durationEdited.value || !m || !totalScu.value) return;
  const total = Math.ceil(estimateJob(totalScu.value, m).seconds / 60);
  hours.value = String(Math.floor(total / 60));
  minutes.value = String(total % 60);
});
watch(() => rows.map((r) => [r.ore, r.amount, method.value, location.value]), () => {
  for (const r of rows) {
    const e = rowEstimate(r);
    if (e && !r.yieldEdited) r.expectedYield = String(e.yieldScu);
  }
}, { deep: true });

const wholeOf = (text: string) => (/^\s*\d{0,6}\s*$/.test(text) ? Number(text.trim() || "0") : null);
// null: invalid (not whole numbers, minutes over 59, or no time at all)
const durationSeconds = computed(() => {
  const h = wholeOf(hours.value);
  const m = wholeOf(minutes.value);
  return h === null || m === null || m > 59 || h * 60 + m === 0 ? null : (h * 60 + m) * 60;
});

const rowValid = (r: OreRow) => !!r.ore && q(r) !== null && !!amt(r) && expectedAmt(r) !== null;
const valid = computed(() => !!location.value && durationSeconds.value !== null && rows.length > 0 && rows.every(rowValid));

function addRow() {
  rows.push(newRow());
}

function removeRow(id: number) {
  const i = rows.findIndex((r) => r.id === id);
  if (i >= 0) rows.splice(i, 1);
  if (!rows.length) rows.push(newRow());
}

// Back to an empty form (the method's estimates again)
function clear() {
  location.value = null;
  method.value = methodOptions.value[0]?.value ?? "";
  hours.value = "";
  minutes.value = "";
  durationEdited.value = false;
  rows.splice(0, rows.length, newRow());
}

async function submit() {
  if (!valid.value || busy.value) return;
  const ores = rows.map((r) => `${qty(amt(r)!, "SCU")} ${materials.value.get(r.ore!)?.name ?? ""}`).join(", ");
  const what = `${ores} · ${locations.value.get(location.value!)?.short ?? ""} · ${methods.value.get(method.value)?.name ?? ""} · ${hm(durationSeconds.value!)}`;
  busy.value = true;
  try {
    const body: RefineryStartRequest = {
      locationUuid: location.value!,
      durationSeconds: durationSeconds.value!,
      rows: rows.map((r) => {
        const expected = expectedAmt(r);
        return { oreUuid: r.ore!, quality: q(r)!, amount: r.amount.trim(), ...(expected ? { expectedYield: expected } : {}) };
      }),
    };
    if (method.value) body.method = method.value;
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
      {{ t("field.method") }}
      <Dropdown v-model="method" variant="chip" :options="methodOptions" />
    </div>
    <div class="field">
      {{ t("field.duration") }}
      <span class="with-unit">
        <input v-model="hours" class="input short" :class="{ invalid: durationSeconds === null }" type="text" inputmode="numeric" @input="durationEdited = true" />
        <span class="unit">{{ t("unit.h") }}</span>
        <input v-model="minutes" class="input short" :class="{ invalid: durationSeconds === null }" type="text" inputmode="numeric" @input="durationEdited = true" />
        <span class="unit">{{ t("unit.min") }}</span>
      </span>
    </div>

    <div class="ore-rows">
      <span class="field">{{ t("field.ore") }}</span>
      <span class="field">{{ t("field.quality") }}</span>
      <span class="field">{{ t("field.amount") }}</span>
      <span class="field">{{ t("field.expectedYield") }}</span>
      <span />
      <template v-for="r in rows" :key="r.id">
        <Picker v-model="r.ore" :options="oreOptions" :placeholder="t('pick.ore')" />
        <input v-model="r.quality" class="input" :class="{ invalid: r.quality.trim() !== '' && q(r) === null }" type="text" inputmode="numeric" placeholder="0–1000" />
        <span class="with-unit">
          <input v-model="r.amount" class="input" :class="{ invalid: r.amount.trim() !== '' && !amt(r) }" type="text" inputmode="decimal" />
          <span class="unit">{{ unitText("SCU") }}</span>
        </span>
        <span class="with-unit">
          <input v-model="r.expectedYield" class="input" :class="{ invalid: expectedAmt(r) === null }" type="text" inputmode="decimal" @input="r.yieldEdited = true" />
          <span class="unit">{{ unitText("SCU") }}</span>
        </span>
        <button type="button" class="icon-btn" :title="t('refinery.removeOre')" @click="removeRow(r.id)"><Icon name="trash" :size="14" /></button>
      </template>
    </div>

    <div class="form-actions">
      <button type="button" class="btn outline add-ore" @click="addRow"><Icon name="plus" :size="14" /> {{ t("refinery.addOre") }}</button>
      <button type="button" class="btn outline" @click="clear"><Icon name="close" :size="14" /> {{ t("common.clear") }}</button>
      <button type="submit" class="btn primary" :disabled="!valid || busy">
        <Icon name="plus" :size="14" /> {{ t("refinery.start") }}
      </button>
    </div>
  </form>
</template>

<style scoped>
/* The ores of the job: one line each, the column names once above them */
.ore-rows {
  grid-column: 1 / -1;
  display: grid;
  grid-template-columns: minmax(180px, 2fr) minmax(90px, 1fr) minmax(130px, 1fr) minmax(130px, 1fr) 32px;
  gap: 8px 12px;
  align-items: center;
}

/* "Add ore" sits on the left, the form's own buttons on the right */
.add-ore {
  margin-right: auto;
}
</style>
