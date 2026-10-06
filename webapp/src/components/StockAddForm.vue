<script setup lang="ts">
// Books new stock (POST /api/stock/add) or starts a refinery job (POST /api/refinery/start, always
// personal, ores only), after a confirmation step like every action.
import { computed, ref, watch } from "vue";
import type { OkResponse, RefineryStartRequest, StockAddRequest } from "../../../src/webapp/api-types";
import ConfirmDialog, { type ConfirmButton } from "./ConfirmDialog.vue";
import Dropdown from "./Dropdown.vue";
import { api } from "../api";
import { locationOptions, locations, materialOptions, materials, oreOptions } from "../catalog";
import { amountOf, qty, qualityOf, unitText } from "../format";
import Icon from "../../../web/src/components/Icon.vue";
import { t } from "../i18n";
import { ensureMembers, memberOptions, members, orgOf, writable } from "../orgs";
import { me } from "../session";
import { toast, toastError } from "../toasts";
import Picker from "./Picker.vue";

const props = defineProps<{ refinery?: boolean; target?: string | null }>();
const emit = defineEmits<{ done: [] }>();

const subject = ref<string | null>(null);
const location = ref<string | null>(null);
const quality = ref("");
const amount = ref("");
// "personal" or a guildId
const target = ref("personal");
const holder = ref<string | null>(null);
const busy = ref(false);
// The summary waiting for confirmation, null while editing
const pending = ref<string | null>(null);

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
const valid = computed(() => !!subject.value && !!location.value && q.value !== null && !!amt.value && (!pickHolder.value || !!holder.value));

function ownerText(): string {
  if (props.refinery || !org.value) return t("stock.pers");
  const name = members[org.value.guildId]?.find((m) => m.userId === holder.value)?.displayName ?? org.value.displayName;
  return `${org.value.name} (${name})`;
}

function submit() {
  if (!valid.value || busy.value) return;
  pending.value = `${qty(amt.value!, unit.value)} ${materials.value.get(subject.value!)?.name ?? ""} · Q${q.value} · ${
    locations.value.get(location.value!)?.short ?? ""} · ${ownerText()}`;
}

const confirmButtons = computed<ConfirmButton[]>(() => [
  { label: t("common.cancel"), kind: "outline", value: "cancel" },
  { label: t("common.confirm"), kind: "primary", value: "confirm", disabled: busy.value },
]);

function choose(value: string) {
  if (value === "confirm") void book();
  else pending.value = null;
}

async function book() {
  const what = pending.value;
  if (!what || !valid.value || busy.value) return;
  busy.value = true;
  try {
    if (props.refinery) {
      const body: RefineryStartRequest = { oreUuid: subject.value!, locationUuid: location.value!, quality: q.value!, amount: amount.value.trim() };
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
    pending.value = null;
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
    <div v-if="!refinery && targets.length > 1" class="field">
      {{ t("field.target") }}
      <Dropdown v-model="target" variant="chip" :options="targets" />
    </div>
    <label v-if="pickHolder && org" class="field">
      {{ t("field.holder") }}
      <Picker v-model="holder" :options="memberOptions(org.guildId)" :placeholder="t('pick.member')" />
    </label>
    <div class="form-actions">
      <button class="btn primary" type="submit" :disabled="!valid || busy"><Icon :name="refinery ? 'drop' : 'plus'" :size="14" /> {{ t(refinery ? "refinery.start" : "stock.add") }}</button>
    </div>
    <ConfirmDialog
      v-if="pending"
      :title="t(refinery ? 'confirm.refineryStart' : 'confirm.add')"
      :subtitle="pending"
      :icon="refinery ? 'crafter' : 'plus'"
      :buttons="confirmButtons"
      @choose="choose"
    />
  </form>
</template>
