<script setup lang="ts">
// Books new stock (POST /api/stock/add) right away; the toast says what was booked. Ores only go
// into the refinery (RefineryStartForm). `target`: null = personal, a guildId = that org (fixed, as the
// list shows it), undefined = the form asks (personal or one of your orgs).
import { computed, ref, watch } from "vue";
import type { OkResponse, StockAddRequest } from "../../../src/webapp/api-types";
import Dropdown from "./Dropdown.vue";
import Icon from "../../../adminapp/src/components/Icon.vue";
import { api } from "../api";
import { locationOptions, locations, materialOptions, materials } from "../catalog";
import { amountOf, qText, qty, qualityOf, unitText } from "../format";
import { t } from "../i18n";
import { orgOf } from "../orgs";
import { me } from "../session";
import { toast, toastError } from "../toasts";
import Picker from "./Picker.vue";

const props = defineProps<{ target?: string | null }>();
const emit = defineEmits<{ done: [] }>();

const subject = ref<string | null>(null);
const location = ref<string | null>(null);
const quality = ref("");
const amount = ref("");
// "personal" or a guildId
const target = ref("personal");
const busy = ref(false);

const pickTarget = computed(() => props.target === undefined);
const targets = computed(() => [
  { value: "personal", label: t("stock.personal") },
  ...(me.value?.orgs ?? []).map((o) => ({ value: o.guildId, label: o.name })),
]);

// A fixed target is the list's scope; picking starts with personal
watch(() => props.target, (g) => {
  target.value = g ?? "personal";
}, { immediate: true });
// A picked org that turned read-only (or was left) is no target anymore; a fixed one stays (the
// list closes the form) and is never swapped for another
watch(targets, (list) => {
  if (pickTarget.value && !list.some((o) => o.value === target.value)) target.value = "personal";
});

const org = computed(() => (target.value === "personal" ? undefined : orgOf(target.value)));

const unit = computed(() => (subject.value ? materials.value.get(subject.value)?.unit : undefined) ?? "SCU");
const q = computed(() => qualityOf(quality.value));
const amt = computed(() => amountOf(amount.value, unit.value));

const valid = computed(() => !!subject.value && !!location.value && q.value !== null && !!amt.value);

const ownerText = () => (org.value ? `${org.value.name} (${org.value.displayName})` : t("stock.pers"));

// Back to an empty form (target as on opening)
function clear() {
  subject.value = null;
  location.value = null;
  quality.value = "";
  amount.value = "";
  target.value = props.target ?? "personal";
}

async function submit() {
  if (!valid.value || busy.value) return;
  const what = `${qty(amt.value!, unit.value)} ${materials.value.get(subject.value!)?.name ?? ""} · ${qText(q.value)} · ${
    locations.value.get(location.value!)?.short ?? ""} · ${ownerText()}`;
  busy.value = true;
  try {
    const body: StockAddRequest = { subjectUuid: subject.value!, locationUuid: location.value!, quality: q.value!, amount: amount.value.trim() };
    if (org.value) body.guildId = org.value.guildId;
    await api<OkResponse>("/stock/add", { method: "POST", body });
    toast(t("stock.added", { what }));
    // The next batch is often the same material at the same place: keep those
    amount.value = "";
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
      {{ t("field.material") }}
      <Picker v-model="subject" :options="materialOptions" :placeholder="t('pick.material')" />
    </label>
    <label class="field">
      {{ t("field.location") }}
      <Picker v-model="location" :options="locationOptions" :placeholder="t('pick.location')" />
    </label>
    <label class="field">
      {{ t("field.quality") }}
      <input v-model="quality" class="input" :class="{ invalid: quality.trim() !== '' && q === null }" type="text" inputmode="numeric" placeholder="0–1000" />
    </label>
    <label class="field">
      {{ t("field.amount") }}
      <span class="with-unit">
        <input v-model="amount" class="input" :class="{ invalid: amount.trim() !== '' && !amt }" type="text" inputmode="decimal" />
        <span class="unit">{{ unitText(unit) }}</span>
      </span>
    </label>
    <div v-if="pickTarget && targets.length > 1" class="field">
      {{ t("field.target") }}
      <Dropdown v-model="target" variant="chip" :options="targets" />
    </div>
    <div class="form-actions">
      <button type="button" class="btn outline" @click="clear"><Icon name="close" :size="14" /> {{ t("common.clear") }}</button>
      <button type="submit" class="btn primary" :disabled="!valid || busy">
        <Icon name="plus" :size="14" /> {{ t("stock.add") }}
      </button>
    </div>
  </form>
</template>
