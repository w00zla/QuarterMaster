<script setup lang="ts">
// Books new stock (POST /api/stock/add) right away; the toast says what was booked. Ores only go
// into the refinery (RefineryStartForm). Sharing is a switch per org; `target` = the list's scope:
// a guildId starts with that org switched on, null/undefined with none. `components`: ship components
// instead of materials (no quality: booked with 0).
import { computed, reactive, ref, watch } from "vue";
import type { OkResponse, StockAddRequest } from "../../../src/webapp/api-types";
import Icon from "../../../adminapp/src/components/Icon.vue";
import { api } from "../api";
import { componentOptions, locationOptions, locations, materialOptions, materials } from "../catalog";
import { amountOf, qText, qty, qualityOf, unitText } from "../format";
import { t } from "../i18n";
import { me } from "../session";
import { toast, toastError } from "../toasts";
import Picker from "./Picker.vue";

const props = defineProps<{ target?: string | null; components?: boolean }>();
const emit = defineEmits<{ done: [] }>();

const subject = ref<string | null>(null);
const location = ref<string | null>(null);
const quality = ref("");
const amount = ref("");
const shareIn = reactive({} as Record<string, boolean>);
const busy = ref(false);

const orgs = computed(() => me.value?.orgs ?? []);
// Only orgs you are an active member of (one you left drops out)
const shared = computed(() => orgs.value.filter((o) => shareIn[o.guildId]));

function resetShares() {
  for (const g of Object.keys(shareIn)) delete shareIn[g];
  if (props.target) shareIn[props.target] = true;
}
watch(() => props.target, resetShares, { immediate: true });

const unit = computed(() => (subject.value ? materials.value.get(subject.value)?.unit : undefined) ?? "SCU");
const q = computed(() => (props.components ? 0 : qualityOf(quality.value)));
const amt = computed(() => amountOf(amount.value, unit.value));

const valid = computed(() => !!subject.value && !!location.value && q.value !== null && !!amt.value);

const ownerText = () => (shared.value.length ? shared.value.map((o) => o.name).join(", ") : t("stock.pers"));

// Back to an empty form (sharing as on opening)
function clear() {
  subject.value = null;
  location.value = null;
  quality.value = "";
  amount.value = "";
  resetShares();
}

async function submit() {
  if (!valid.value || busy.value) return;
  const m = materials.value.get(subject.value!);
  const what = `${qty(amt.value!, unit.value)} ${props.components ? m?.label ?? "" : `${m?.name ?? ""} · ${qText(q.value)}`} · ${
    locations.value.get(location.value!)?.short ?? ""} · ${ownerText()}`;
  busy.value = true;
  try {
    const body: StockAddRequest = { subjectUuid: subject.value!, locationUuid: location.value!, quality: q.value!, amount: amount.value.trim() };
    if (shared.value.length) body.guildIds = shared.value.map((o) => o.guildId);
    await api<OkResponse>("/stock/add", { method: "POST", body });
    toast(t("stock.added", { what }));
    // The next batch is often the same material at the same place, shared the same way: keep those
    quality.value = "";
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
      {{ components ? t("field.component") : t("field.material") }}
      <Picker v-model="subject" :options="components ? componentOptions : materialOptions" :placeholder="components ? t('pick.component') : t('pick.material')" />
    </label>
    <label class="field">
      {{ t("field.location") }}
      <Picker v-model="location" :options="locationOptions" :placeholder="t('pick.location')" />
    </label>
    <label v-if="!components" class="field">
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
    <div class="form-actions">
      <div v-if="orgs.length" class="field share-field">
        {{ t("field.sharing") }}
        <div class="share-list">
          <label v-for="o in orgs" :key="o.guildId" class="share-row">
            <input v-model="shareIn[o.guildId]" class="switch" type="checkbox" />
            <span class="share-org">{{ o.name }}</span>
          </label>
        </div>
      </div>
      <button type="button" class="btn outline" @click="clear"><Icon name="close" :size="14" /> {{ t("common.clear") }}</button>
      <button type="submit" class="btn primary" :disabled="!valid || busy">
        <Icon name="plus" :size="14" /> {{ t("stock.add") }}
      </button>
    </div>
  </form>
</template>

<style scoped>
/* Sharing on the left of the buttons' row, the switches side by side */
.form-actions {
  align-items: flex-end;
}

.share-field {
  margin-right: auto;
}

.share-list {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px 16px;
  min-height: 32px;
}
</style>
