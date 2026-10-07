<script setup lang="ts">
// Books new stock (POST /api/stock/add) or starts a refinery job (POST /api/refinery/start, always
// personal, ores only) right away; the toast says what was booked.
import { computed, ref, watch } from "vue";
import { estimateJob } from "../../../src/ext/refining-estimate";
import type { OkResponse, RefineryStartRequest, StockAddRequest } from "../../../src/webapp/api-types";
import Dropdown from "./Dropdown.vue";
import Icon from "../../../adminapp/src/components/Icon.vue";
import { api } from "../api";
import { locationOptions, locations, materialOptions, materials, methods, oreOptions, refineryLocationOptions, yieldBonus, yieldValue } from "../catalog";
import { amountOf, hm, qText, qty, qualityOf, unitText } from "../format";
import { t } from "../i18n";
import { ensureMembers, memberOptions, members, orgOf, writable } from "../orgs";
import { me } from "../session";
import { toast, toastError } from "../toasts";
import Picker from "./Picker.vue";

const props = defineProps<{ refinery?: boolean; target?: string | null }>();
const emit = defineEmits<{ done: [] }>();

const subject = ref<string | null>(null);
const location = ref<string | null>(null);
// Refineries carry the UEX yield bonus for the picked ore
const refineryOptions = computed(() => refineryLocationOptions.value.map((o) => {
  const bonus = yieldBonus(o.value, subject.value);
  return bonus ? { ...o, label: `${o.label} · ${bonus}` } : o;
}));
const quality = ref("");
const amount = ref("");
// "personal" or a guildId
const target = ref("personal");
const holder = ref<string | null>(null);
const busy = ref(false);

const targets = computed(() => [
  { value: "personal", label: t("stock.personal") },
  ...(me.value?.orgs ?? []).filter(writable).map((o) => ({ value: o.guildId, label: o.name })),
]);

// Follows the list's scope while that org can be booked into
watch(() => props.target, (g) => {
  target.value = g && writable(orgOf(g)) ? g : "personal";
}, { immediate: true });
// An org that turned read-only (or was left) is no target anymore
watch(targets, (list) => {
  if (!list.some((o) => o.value === target.value)) target.value = "personal";
});

const org = computed(() => (target.value === "personal" ? undefined : orgOf(target.value)));
// Officers book org stock for other holders too
const pickHolder = computed(() => !props.refinery && !!org.value?.officer);
watch(org, (o) => {
  holder.value = me.value?.userId ?? null;
  if (o?.officer) ensureMembers(o.guildId);
}, { immediate: true });

const unit = computed(() => (subject.value ? materials.value.get(subject.value)?.unit : undefined) ?? "SCU");
const q = computed(() => qualityOf(quality.value));
const amt = computed(() => amountOf(amount.value, unit.value));

// --- refinery: method, then duration and expected yield, prefilled from the method's community values
// (and the station's UEX bonus) until the user types into them, e.g. the terminal's numbers -------
const method = ref("");
const hours = ref("");
const minutes = ref("");
const expectedYield = ref("");
const durationEdited = ref(false);
const yieldEdited = ref(false);

const methodOptions = computed(() => [...methods.value.values()].map((m) => ({ value: m.code, label: `${m.name} · ${m.yieldPct} %` })));
watch(methodOptions, (o) => {
  if (!method.value && o.length) method.value = o[0]!.value;
}, { immediate: true });

const estimate = computed(() => {
  const m = methods.value.get(method.value);
  if (!props.refinery || !m || !amt.value) return null;
  return estimateJob(Number(amt.value), m, (location.value && yieldValue(location.value, subject.value)) || 0);
});
watch(estimate, (e) => {
  if (!e) return;
  if (!durationEdited.value) {
    const total = Math.ceil(e.seconds / 60);
    hours.value = String(Math.floor(total / 60));
    minutes.value = String(total % 60);
  }
  if (!yieldEdited.value) expectedYield.value = String(e.yieldScu);
});

const wholeOf = (text: string) => (/^\s*\d{0,6}\s*$/.test(text) ? Number(text.trim() || "0") : null);
// null: invalid (not whole numbers, minutes over 59, or no time at all)
const durationSeconds = computed(() => {
  const h = wholeOf(hours.value);
  const m = wholeOf(minutes.value);
  return h === null || m === null || m > 59 || h * 60 + m === 0 ? null : (h * 60 + m) * 60;
});
const expectedAmt = computed(() => (expectedYield.value.trim() ? amountOf(expectedYield.value, "SCU") : ""));
const refineValid = computed(() => !props.refinery || (durationSeconds.value !== null && expectedAmt.value !== null));

const valid = computed(() => !!subject.value && !!location.value && q.value !== null && !!amt.value && (!pickHolder.value || !!holder.value)
  && refineValid.value);

function ownerText(): string {
  if (props.refinery || !org.value) return t("stock.pers");
  const name = members[org.value.guildId]?.find((m) => m.userId === holder.value)?.displayName ?? org.value.displayName;
  return `${org.value.name} (${name})`;
}

// Back to an empty form (target and holder as on opening, the method's estimates again)
function clear() {
  subject.value = null;
  location.value = null;
  quality.value = "";
  amount.value = "";
  target.value = props.target && writable(orgOf(props.target)) ? props.target : "personal";
  holder.value = me.value?.userId ?? null;
  method.value = methodOptions.value[0]?.value ?? "";
  hours.value = "";
  minutes.value = "";
  expectedYield.value = "";
  durationEdited.value = false;
  yieldEdited.value = false;
}

async function submit() {
  if (!valid.value || busy.value) return;
  const job = props.refinery
    ? ` · ${methods.value.get(method.value)?.name ?? ""}${expectedAmt.value ? ` · ≈ ${qty(expectedAmt.value, "SCU")}` : ""} · ${hm(durationSeconds.value!)}`
    : "";
  const what = `${qty(amt.value!, unit.value)} ${materials.value.get(subject.value!)?.name ?? ""} · ${qText(q.value)} · ${
    locations.value.get(location.value!)?.short ?? ""} · ${ownerText()}${job}`;
  busy.value = true;
  try {
    if (props.refinery) {
      const body: RefineryStartRequest = {
        oreUuid: subject.value!, locationUuid: location.value!, quality: q.value!, amount: amount.value.trim(),
        durationSeconds: durationSeconds.value!,
      };
      if (method.value) body.method = method.value;
      if (expectedAmt.value) body.expectedYield = expectedAmt.value;
      await api<OkResponse>("/refinery/start", { method: "POST", body });
      toast(t("refinery.started", { what }));
    } else {
      const body: StockAddRequest = { subjectUuid: subject.value!, locationUuid: location.value!, quality: q.value!, amount: amount.value.trim() };
      if (org.value) {
        body.guildId = org.value.guildId;
        if (holder.value && holder.value !== me.value?.userId) body.holderUserId = holder.value;
      }
      await api<OkResponse>("/stock/add", { method: "POST", body });
      toast(t("stock.added", { what }));
    }
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
      {{ t(refinery ? "field.ore" : "field.material") }}
      <Picker v-model="subject" :options="refinery ? oreOptions : materialOptions" :placeholder="t(refinery ? 'pick.ore' : 'pick.material')" />
    </label>
    <label class="field">
      {{ t("field.location") }}
      <Picker v-model="location" :options="refinery ? refineryOptions : locationOptions" :placeholder="t('pick.location')" />
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
    <template v-if="refinery">
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
      <label class="field">
        {{ t("field.expectedYield") }}
        <span class="with-unit">
          <input v-model="expectedYield" class="input" :class="{ invalid: expectedAmt === null }" type="text" inputmode="decimal" @input="yieldEdited = true" />
          <span class="unit">{{ unitText("SCU") }}</span>
        </span>
      </label>
    </template>
    <div v-if="!refinery && targets.length > 1" class="field">
      {{ t("field.target") }}
      <Dropdown v-model="target" variant="chip" :options="targets" />
    </div>
    <label v-if="pickHolder && org" class="field">
      {{ t("field.holder") }}
      <Picker v-model="holder" :options="memberOptions(org.guildId)" :placeholder="t('pick.member')" />
    </label>
    <div class="form-actions">
      <button type="button" class="btn outline" @click="clear"><Icon name="close" :size="14" /> {{ t("common.clear") }}</button>
      <button type="submit" class="btn primary" :disabled="!valid || busy">
        <Icon name="plus" :size="14" /> {{ t(refinery ? "refinery.start" : "stock.add") }}
      </button>
    </div>
  </form>
</template>
