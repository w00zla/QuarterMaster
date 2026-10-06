<script setup lang="ts">
// Where is a material? GET /api/stock/find: stored batches of the org (if picked) plus your personal
// ones, best quality first. Runs again when that stock changes.
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import type { StockBatch, StockListResponse } from "../../../src/webapp/api-types";
import Icon from "../../../adminapp/src/components/Icon.vue";
import Dropdown from "./Dropdown.vue";
import { api } from "../api";
import { materialOptions } from "../catalog";
import { ownerText, qty, qualityOf } from "../format";
import { lang, t } from "../i18n";
import { onServerMessage } from "../realtime";
import { me } from "../session";
import { toastError } from "../toasts";
import Picker from "./Picker.vue";

const props = defineProps<{ guildId?: string | null }>();

const subject = ref<string | null>(null);
const minQuality = ref("");
const org = ref(props.guildId ?? "");
const result = ref<StockBatch[] | null>(null);
// The query the result belongs to (re-run on changes)
let last: { subject: string; min: number; guildId: string } | null = null;

watch(() => props.guildId, (g) => (org.value = g ?? ""));

const orgOptions = computed(() => [
  { value: "", label: t("stock.findPersonalOnly") },
  ...(me.value?.orgs ?? []).map((o) => ({ value: o.guildId, label: o.name })),
]);
const min = computed(() => (minQuality.value.trim() === "" ? 0 : qualityOf(minQuality.value)));
const valid = computed(() => !!subject.value && min.value !== null);

let seq = 0;
async function fetchResult() {
  if (!last) return;
  const mine = ++seq;
  const query = new URLSearchParams({ subject: last.subject, minQuality: String(last.min) });
  if (last.guildId) query.set("guildId", last.guildId);
  // Material and location names (the server reads it, the contract does not list it yet)
  query.set("lang", lang.value);
  try {
    // The contract does not name the find response; a list response, or a bare array
    const r = await api<StockListResponse | StockBatch[]>(`/stock/find?${query}`);
    if (mine === seq) result.value = Array.isArray(r) ? r : r.batches;
  } catch (e) {
    if (mine === seq) toastError(e);
  }
}

function run() {
  if (!valid.value) return;
  last = { subject: subject.value!, min: min.value!, guildId: org.value };
  void fetchResult();
}

watch(lang, fetchResult);

let unsubscribe = () => {};
onMounted(() => {
  unsubscribe = onServerMessage((m) => {
    if (!last) return;
    if (m.type === "resync" || (m.type === "stock" && (m.scope === "personal" || m.guildId === last.guildId))) void fetchResult();
  });
});
onUnmounted(() => unsubscribe());
</script>

<template>
  <div>
    <form class="form" @submit.prevent="run">
      <label class="field">
        {{ t("field.material") }}
        <Picker v-model="subject" :options="materialOptions" :placeholder="t('pick.material')" />
      </label>
      <label class="field">
        {{ t("field.minQuality") }}
        <input v-model="minQuality" class="input" :class="{ invalid: min === null }" type="text" inputmode="numeric" placeholder="0" />
      </label>
      <div v-if="orgOptions.length > 1" class="field">
        {{ t("field.org") }}
        <Dropdown v-model="org" variant="chip" :options="orgOptions" />
      </div>
      <div class="form-actions">
        <button class="btn primary" type="submit" :disabled="!valid"><Icon name="search" :size="14" /> {{ t("stock.findRun") }}</button>
      </div>
    </form>
    <template v-if="result">
      <div v-if="!result.length" class="empty-line">{{ t("stock.findNone") }}</div>
      <div v-for="b in result" :key="b.id" class="list-row">
        <span class="q">Q{{ b.quality }}</span>
        <span class="amount">{{ qty(b.quantity, b.unit) }}</span>
        <span>{{ b.material }}</span>
        <span class="dim">{{ b.location }}</span>
        <span class="faint">{{ ownerText(b) }}</span>
      </div>
    </template>
  </div>
</template>
