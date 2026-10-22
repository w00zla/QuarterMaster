<script setup lang="ts">
// Books new stock (POST /api/stock/add) right away; the toast says what was booked. Ores only go
// into the refinery (RefineryStartForm). Sharing is a switch per org; `target` = the list's scope:
// a guildId starts with that org switched on, null/undefined with none. `components`: ship components
// instead of materials (no quality: booked with 0; instead the stats its blueprint gives it, each optional).
import { computed, reactive, ref, watch } from "vue";
import type { OkResponse, StockAddRequest } from "../../../src/webapp/api-types";
import Icon from "../../../adminapp/src/components/Icon.vue";
import { api } from "../api";
import { componentOptions, locationOptions, locations, materialOptions, materials } from "../catalog";
import { amountInput, amountOf, qText, qty, qualityOf, statsText } from "../format";
import { t } from "../i18n";
import { me } from "../session";
import { toast, toastError } from "../toasts";
import AmountStepper from "./AmountStepper.vue";
import Picker from "./Picker.vue";
import StatSliders, { statsOf } from "./StatSliders.vue";

const props = defineProps<{ target?: string | null; components?: boolean }>();
const emit = defineEmits<{ done: [] }>();

const subject = ref<string | null>(null);
const location = ref<string | null>(null);
const quality = ref("");
// One to start with (1,0 SCU, one piece)
const startAmount = () => amountInput(1, unit.value);
const amount = ref("1");
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
// Die Startmenge folgt der Einheit (SCU ↔ Stück), solange sie nicht geändert wurde
watch(unit, (now, before) => {
  if (amount.value === amountInput(1, before)) amount.value = amountInput(1, now);
});
amount.value = startAmount();

// Components: the picked one's stats (StatSliders); only gains are sent
const statDefs = computed(() => (props.components && subject.value ? materials.value.get(subject.value)?.stats ?? [] : []));
const statValues = ref<Record<string, number>>({});
const clearStats = () => (statValues.value = {});
watch(subject, clearStats);

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
  const stats = statsOf(statDefs.value, statValues.value);
  const statLine = statsText(subject.value!, Object.keys(stats).length ? stats : null);
  const what = `${props.components ? [m?.label ?? "", statLine].filter(Boolean).join(" · ") : `${qty(amt.value!, unit.value)} ${m?.name ?? ""} · ${qText(q.value)}`} · ${
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
    <div class="pick-pair" :class="{ 'with-stats': statDefs.length }">
      <label class="field">
        {{ components ? t("field.component") : t("field.resource") }}
        <Picker v-model="subject" strong :options="components ? componentOptions : materialOptions" :placeholder="components ? t('pick.component') : t('pick.resource')" />
      </label>
      <label class="field">
        {{ t("field.location") }}
        <Picker v-model="location" :options="locationOptions" :placeholder="t('pick.location')" />
      </label>
      <!-- The picked component's stats, right of the location, as wide as the pick -->
      <StatSliders v-if="statDefs.length" v-model="statValues" :defs="statDefs" />
    </div>
    <label v-if="!components" class="field">
      {{ t("field.quality") }}
      <input v-model="quality" class="input" :class="{ invalid: quality.trim() !== '' && q === null }" type="text" inputmode="numeric" placeholder="0–1000" />
    </label>
    <!-- Ausrüstung stapelt im Spiel nicht: immer genau ein Stück (amount bleibt "1"), kein Feld -->
    <div v-if="!components" class="field">
      {{ t("field.amount") }}
      <AmountStepper v-model="amount" :unit="unit" :invalid="amount.trim() !== '' && !amt" :label="t('field.amount')" />
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

/* Material/component and location share three grid cells, the main pick a bit wider (long labels both);
   on narrow screens one cell each (the stats below them) */
.pick-pair {
  display: contents;
}

@media (min-width: 720px) {
  .pick-pair {
    grid-column: span 3;
    display: grid;
    grid-template-columns: 8fr 5fr;
    gap: 12px;
    align-items: end;
  }

  /* With stats the whole row: the stats right of the location, as wide as the material/component; the
     fields at the top (the sliders are taller) */
  .pick-pair.with-stats {
    grid-column: 1 / -1;
    grid-template-columns: 8fr 5fr 8fr;
    align-items: start;
  }

  .pick-pair > .stats-row {
    grid-column: auto;
  }
}

.share-list {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px 16px;
  min-height: 32px;
}
</style>
