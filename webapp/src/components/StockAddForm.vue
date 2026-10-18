<script setup lang="ts">
// Books new stock (POST /api/stock/add) right away; the toast says what was booked. Ores only go
// into the refinery (RefineryStartForm). Sharing is a switch per org; `target` = the list's scope:
// a guildId starts with that org switched on, null/undefined with none. `components`: ship components
// instead of materials (no quality: booked with 0; instead the stats its blueprint gives it, each optional).
import { computed, reactive, ref, watch } from "vue";
import type { CatalogStat, OkResponse, StockAddRequest } from "../../../src/webapp/api-types";
import Icon from "../../../adminapp/src/components/Icon.vue";
import { api } from "../api";
import { componentOptions, locationOptions, locations, materialOptions, materials } from "../catalog";
import { amountOf, qText, qty, qualityOf, statsText, statValueText } from "../format";
import { t } from "../i18n";
import { me } from "../session";
import { toast, toastError } from "../toasts";
import AmountStepper from "./AmountStepper.vue";
import Picker from "./Picker.vue";

const props = defineProps<{ target?: string | null; components?: boolean }>();
const emit = defineEmits<{ done: [] }>();

const subject = ref<string | null>(null);
const location = ref<string | null>(null);
const quality = ref("");
// One to start with (1 SCU, one piece)
const startAmount = () => "1";
const amount = ref(startAmount());
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

// Components are counted in pieces, also before one is picked
const unit = computed(() => (subject.value ? materials.value.get(subject.value)?.unit : undefined) ?? (props.components ? "pcs" : "SCU"));
const q = computed(() => (props.components ? 0 : qualityOf(quality.value)));
const amt = computed(() => amountOf(amount.value, unit.value));

// Components: one slider per stat the picked one can carry, from no change (looted, or crafted without
// a gain) to the best its blueprint can make of it; only gains are sent
const statDefs = computed(() => (props.components && subject.value ? materials.value.get(subject.value)?.stats ?? [] : []));
const statValues = reactive({} as Record<string, number>);
const clearStats = () => {
  for (const k of Object.keys(statValues)) delete statValues[k];
};
watch(subject, clearStats);
const valueOf = (s: CatalogStat) => statValues[s.uuid] ?? s.min;
const setValue = (s: CatalogStat, e: Event) => (statValues[s.uuid] = Number((e.target as HTMLInputElement).value));
// As stored: one decimal for a percent, whole steps
const statText = (s: CatalogStat) => (s.kind === "multiplier" ? valueOf(s).toFixed(1) : String(Math.round(valueOf(s))));

const valid = computed(() => !!subject.value && !!location.value && q.value !== null && !!amt.value);

const ownerText = () => (shared.value.length ? shared.value.map((o) => o.name).join(", ") : t("stock.pers"));

// Back to an empty form (sharing as on opening)
function clear() {
  subject.value = null;
  location.value = null;
  quality.value = "";
  amount.value = startAmount();
  clearStats();
  resetShares();
}

async function submit() {
  if (!valid.value || busy.value) return;
  const m = materials.value.get(subject.value!);
  const stats = Object.fromEntries(statDefs.value.filter((s) => valueOf(s) > 0).map((s) => [s.uuid, statText(s)]));
  const statLine = statsText(subject.value!, Object.keys(stats).length ? stats : null);
  const what = `${qty(amt.value!, unit.value)} ${props.components ? [m?.label ?? "", statLine].filter(Boolean).join(" · ") : `${m?.name ?? ""} · ${qText(q.value)}`} · ${
    locations.value.get(location.value!)?.short ?? ""} · ${ownerText()}`;
  busy.value = true;
  try {
    const body: StockAddRequest = { subjectUuid: subject.value!, locationUuid: location.value!, quality: q.value!, amount: amount.value.trim() };
    if (shared.value.length) body.guildIds = shared.value.map((o) => o.guildId);
    if (Object.keys(stats).length) body.stats = stats;
    await api<OkResponse>("/stock/add", { method: "POST", body });
    toast(t("stock.added", { what }));
    // The next batch is often the same material at the same place, shared the same way: keep those
    // (a component's stats are its own)
    quality.value = "";
    amount.value = startAmount();
    clearStats();
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
    <label class="field subject-field">
      {{ components ? t("field.component") : t("field.material") }}
      <Picker v-model="subject" strong :options="components ? componentOptions : materialOptions" :placeholder="components ? t('pick.component') : t('pick.material')" />
    </label>
    <label class="field">
      {{ t("field.location") }}
      <Picker v-model="location" :options="locationOptions" :placeholder="t('pick.location')" />
    </label>
    <label v-if="!components" class="field">
      {{ t("field.quality") }}
      <input v-model="quality" class="input" :class="{ invalid: quality.trim() !== '' && q === null }" type="text" inputmode="numeric" placeholder="0–1000" />
    </label>
    <div class="field">
      {{ components ? t("field.count") : t("field.amount") }}
      <AmountStepper v-model="amount" :unit="unit" :invalid="amount.trim() !== '' && !amt" :label="components ? t('field.count') : t('field.amount')" />
    </div>
    <!-- The picked component's stats, a row of their own: a slider per stat -->
    <div v-if="statDefs.length" class="stats-row">
      <label v-for="s in statDefs" :key="s.uuid" class="field stat-field">
        <span class="stat-head"><span>{{ s.name }}</span><span class="stat-value mono">{{ statValueText(s.kind, statText(s)) }}</span></span>
        <input type="range" :min="s.min" :max="s.max" :step="s.kind === 'multiplier' ? 0.1 : 1" :value="valueOf(s)"
          @input="setValue(s, $event)" />      </label>
    </div>
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

/* The material or component: two grid cells wide (long names and component labels), one on narrow screens */
@media (min-width: 720px) {
  .subject-field {
    grid-column: span 2;
  }
}

/* The stats over the whole width, the sliders laid out like the fields above */
.stats-row {
  grid-column: 1 / -1;
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(min(220px, 100%), 1fr));
  gap: 12px 20px;
  align-items: start;
}

/* Name and value above the slider */
.stat-head {
  display: flex;
  justify-content: space-between;
  gap: 8px;
}

/* Larger than the other field labels: the values are what is read here */
.stat-head {
  font-size: 12.5px;
}

.stat-value {
  font-size: 13px;
  color: var(--text);
}

.stat-field input[type="range"] {
  width: 100%;
  accent-color: var(--accent);
}

.share-list {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px 16px;
  min-height: 32px;
}
</style>
