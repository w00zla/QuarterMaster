<script setup lang="ts">
// Changes one batch: remove, move or adjust (finishing a refinery job: RefineryDoneDialog). Two steps: the inputs, then a
// summary of the change to confirm (every change of existing stock is confirmed). `expected` is the
// quantity shown, so a batch that changed meanwhile is refused (batchChanged) instead of booked.
import { computed, ref, watch } from "vue";
import type {
  OkResponse, StockAdjustRequest, StockBatch, StockMoveRequest, StockRemoveRequest,
} from "../../../src/webapp/api-types";
import type { IconName } from "../../../adminapp/src/components/Icon.vue";
import Dropdown from "./Dropdown.vue";
import { api } from "../api";
import { locationOptions, locations } from "../catalog";
import { amountOf, ownerText, qText, qty, unitText } from "../format";
import { t } from "../i18n";
import { ensureMembers, memberOptions, members, orgOf, writable } from "../orgs";
import { me } from "../session";
import { toast, toastError } from "../toasts";
import ConfirmDialog, { type ConfirmButton } from "./ConfirmDialog.vue";
import Picker from "./Picker.vue";

export type BatchAction = "remove" | "move" | "adjust";

const props = defineProps<{ batch: StockBatch; action: BatchAction }>();
const emit = defineEmits<{ close: []; done: [] }>();

const b = props.batch;
const isOrg = b.designation === "org";
const step = ref<"input" | "confirm">("input");
const busy = ref(false);

// "Everything" is the default for remove and move
const all = ref(props.action === "remove" || props.action === "move");
const amount = ref("");
const location = ref<string | null>(b.locationUuid);
// Move target: personal batch "stay" | guildId (donation); org batch "org" | "personal"
const target = ref(isOrg ? "org" : "stay");
const holder = ref<string | null>(isOrg ? b.holderUserId : (me.value?.userId ?? null));

const unit = computed(() => b.unit);
const amt = computed(() => amountOf(amount.value, unit.value));

const targetOptions = computed(() => isOrg
  ? [{ value: "org", label: t("stock.stayOrg", { org: orgOf(b.guildId)?.name ?? "Org" }) }, { value: "personal", label: t("stock.toPersonal") }]
  : [{ value: "stay", label: t("stock.stayPersonal") },
      ...(me.value?.orgs ?? []).filter(writable).map((o) => ({ value: o.guildId, label: t("stock.donate", { org: o.name }) }))]);

// The org the move happens in, if any
const moveOrg = computed(() => (isOrg ? orgOf(b.guildId) : target.value === "stay" ? undefined : orgOf(target.value)));
// Officers pick the holder (org batch: new holder or who gets it as personal stock; donation: who holds it)
const pickHolder = computed(() => props.action === "move" && !!moveOrg.value?.officer);
watch(moveOrg, (o) => {
  if (o?.officer) ensureMembers(o.guildId);
  if (!isOrg) holder.value = me.value?.userId ?? null;
}, { immediate: true });

const nameOf = (guildId: string, userId: string | null) =>
  members[guildId]?.find((m) => m.userId === userId)?.displayName
  ?? (userId === b.holderUserId ? b.holderName : null)
  ?? (userId === me.value?.userId ? orgOf(guildId)?.displayName : null) ?? "?";

const moveChanges = computed(() => {
  if (location.value !== b.locationUuid) return true;
  if (isOrg) return target.value === "personal" || holder.value !== b.holderUserId;
  return target.value !== "stay";
});

const valid = computed(() => {
  switch (props.action) {
    case "remove": return all.value || !!amt.value;
    // "0" empties the batch: allowed here, unlike everywhere else
    case "adjust": return amount.value.trim() !== "" && (!!amt.value || /^0+([.,]0*)?$/.test(amount.value.trim()));
    case "move": return (all.value || !!amt.value) && !!location.value && moveChanges.value && (!pickHolder.value || !!holder.value);
  }
  return false;
});

const counted = computed(() => amt.value ?? "0");
const amountText = computed(() => (all.value ? `${qty(b.quantity, b.unit)} (${t("stock.allOf")})` : qty(amt.value ?? "", unit.value)));

const targetText = computed(() => {
  const where = locations.value.get(location.value ?? "")?.short ?? b.location;
  if (isOrg) {
    const name = nameOf(b.guildId!, holder.value);
    return `${where} · ${target.value === "personal" ? `${t("stock.pers")} (${name})` : `${orgOf(b.guildId)?.name ?? "Org"} (${name})`}`;
  }
  if (target.value === "stay") return `${where} · ${t("stock.pers")}`;
  return `${where} · ${orgOf(target.value)?.name ?? "Org"} (${nameOf(target.value, holder.value)})`;
});

const titles: Record<BatchAction, Parameters<typeof t>[0]> = {
  remove: "stock.remove", move: "stock.move", adjust: "stock.adjust",
};
const icons: Record<BatchAction, IconName> = { remove: "trash", move: "arrow-right", adjust: "settings" };

const buttons = computed<ConfirmButton[]>(() => step.value === "input"
  ? [
      { label: t("common.cancel"), kind: "outline", value: "cancel" },
      { label: t("common.continue"), kind: "primary", value: "next", disabled: !valid.value },
    ]
  : [
      { label: t("common.cancel"), kind: "outline", value: "cancel" },
      { label: t("common.back"), kind: "outline", value: "back", side: "left" },
      { label: t("common.confirm"), kind: props.action === "remove" ? "danger" : "primary", value: "confirm", disabled: busy.value },
    ]);

function choose(value: string) {
  if (value === "cancel") emit("close");
  else if (value === "back") step.value = "input";
  else if (value === "next" && valid.value) step.value = "confirm";
  else if (value === "confirm") void book();
}

function onEnter(e: KeyboardEvent) {
  // A picker that took the Enter (picking a suggestion) prevents it
  if (e.defaultPrevented || step.value !== "input") return;
  e.preventDefault();
  choose("next");
}

const guildOf = () => (isOrg ? b.guildId! : undefined);

async function book() {
  if (busy.value) return;
  busy.value = true;
  const typed = amount.value.trim();
  try {
    if (props.action === "remove") {
      const body: StockRemoveRequest = { batchId: b.id, amount: all.value ? null : typed, expected: b.quantity, guildId: guildOf() };
      await api<OkResponse>("/stock/remove", { method: "POST", body });
      toast(t("stock.removed", { what: `−${amountText.value} ${b.material} · ${qText(b.quality)} · ${b.location} · ${ownerText(b)}` }));
    } else if (props.action === "adjust") {
      const body: StockAdjustRequest = { batchId: b.id, amount: typed, expected: b.quantity, guildId: guildOf() };
      await api<OkResponse>("/stock/adjust", { method: "POST", body });
      toast(t("stock.adjusted", { what: `${b.quantity} → ${qty(counted.value, b.unit)} ${b.material} · ${qText(b.quality)} · ${b.location}` }));
    } else {
      const body: StockMoveRequest = { batchId: b.id, amount: all.value ? null : typed, expected: b.quantity };
      if (location.value !== b.locationUuid) body.toLocationUuid = location.value!;
      if (isOrg) {
        body.guildId = b.guildId!;
        if (target.value === "personal") body.toOrg = false;
        if (holder.value && holder.value !== b.holderUserId) body.toHolderUserId = holder.value;
      } else if (target.value !== "stay") {
        body.guildId = target.value;
        body.toOrg = true;
        if (holder.value && holder.value !== me.value?.userId) body.toHolderUserId = holder.value;
      }
      await api<OkResponse>("/stock/move", { method: "POST", body });
      toast(t("stock.moved", { what: `${amountText.value} ${b.material} · ${qText(b.quality)} → ${targetText.value}` }));
    }
    emit("done");
    emit("close");
  } catch (e) {
    toastError(e);
    // Refused because the batch changed: the shown quantity is outdated, close (the list reloads)
    if (e instanceof Error && (e.message === "batchChanged" || e.message === "batchNotFound")) emit("close");
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <ConfirmDialog
    :title="step === 'input' ? t(titles[action]) : t('common.checkTitle')"
    :subtitle="`${b.material} · ${qText(b.quality)} · ${qty(b.quantity, b.unit)} · ${b.location} · ${ownerText(b)}`"
    :icon="icons[action]"
    :buttons="buttons"
    @choose="choose"
  >
    <div v-if="step === 'input'" class="form single flush" @keydown.enter="onEnter">
      <div v-if="action === 'remove' || action === 'move'" class="field">
        {{ t("field.amount") }}
        <span class="with-unit">
          <input v-model="amount" class="input" :class="{ invalid: !all && amount.trim() !== '' && !amt }" type="text" inputmode="decimal" :disabled="all" />
          <span class="unit">{{ unitText(b.unit) }}</span>
          <label class="check"><input v-model="all" type="checkbox" /> {{ t("field.everything") }}</label>
        </span>
      </div>
      <label v-if="action === 'adjust'" class="field">
        {{ t("field.counted") }}
        <span class="with-unit">
          <input v-model="amount" class="input" type="text" inputmode="decimal" />
          <span class="unit">{{ unitText(b.unit) }}</span>
        </span>
      </label>
      <template v-if="action === 'move'">
        <label class="field">
          {{ t("field.location") }}
          <Picker v-model="location" :options="locationOptions" :placeholder="t('pick.location')" />
        </label>
        <div v-if="targetOptions.length > 1" class="field">
          {{ t("field.target") }}
          <Dropdown v-model="target" variant="chip" :options="targetOptions" />
        </div>
        <label v-if="pickHolder && moveOrg" class="field">
          {{ t(isOrg && target === "personal" ? "field.recipient" : "field.holder") }}
          <Picker v-model="holder" :options="memberOptions(moveOrg.guildId)" :placeholder="t('pick.member')" />
        </label>
        <div v-if="!moveChanges" class="hint-line">{{ t("stock.nothingToMove") }}</div>
      </template>
    </div>

    <div v-else class="summary">
      <template v-if="action === 'remove'">
        <span class="big">−{{ amountText }} {{ b.material }}</span>
        <span class="dim">{{ qText(b.quality) }} · {{ b.location }} · {{ ownerText(b) }}</span>
      </template>
      <template v-else-if="action === 'adjust'">
        <span class="big">{{ qty(b.quantity, b.unit) }} → {{ qty(counted, b.unit) }} {{ b.material }}</span>
        <span class="dim">{{ qText(b.quality) }} · {{ b.location }} · {{ ownerText(b) }}</span>
      </template>
      <template v-else>
        <span class="big">{{ amountText }} {{ b.material }} · {{ qText(b.quality) }}</span>
        <span><span class="dim">{{ t("stock.from") }}:</span> {{ b.location }} · {{ ownerText(b) }}</span>
        <span><span class="dim">{{ t("stock.to") }}:</span> {{ targetText }}</span>
      </template>
    </div>
  </ConfirmDialog>
</template>
