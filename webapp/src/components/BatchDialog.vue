<script setup lang="ts">
// Changes one of your batches: share (the whole batch, in any of your orgs, or taken back), split
// (unshared batches: a part of its own, e.g. to share apart), merge (a part back into its main batch),
// move, adjust or remove (finishing a
// refinery job: RefineryDoneDialog). Moving covers the place and giving it to a member of one of your
// orgs, who gets it unshared. Two steps: the inputs, then a summary of the change to confirm (every
// change of existing stock is confirmed). `expected` is the quantity shown, so a batch that changed
// meanwhile is refused (batchChanged) instead of booked.
import { computed, reactive, ref, watch } from "vue";
import type {
  OkResponse, StockAdjustRequest, StockBatch, StockMergeRequest, StockMoveRequest, StockRemoveRequest, StockShareRequest, StockSplitRequest,
} from "../../../src/webapp/api-types";
import type { IconName } from "../../../adminapp/src/components/Icon.vue";
import { api } from "../api";
import { locationOptions, locations } from "../catalog";
import { amountOf, ownerText, qText, qty, sharedText, unitText } from "../format";
import { t } from "../i18n";
import { ensureMembers, memberLabel, members, orgOf } from "../orgs";
import { me } from "../session";
import { toast, toastError } from "../toasts";
import ConfirmDialog, { type ConfirmButton } from "./ConfirmDialog.vue";
import Picker from "./Picker.vue";

export type BatchAction = "share" | "split" | "merge" | "move" | "adjust" | "remove";

const props = defineProps<{ batch: StockBatch; action: BatchAction }>();
const emit = defineEmits<{ close: []; done: [] }>();

const b = props.batch;
const step = ref<"input" | "confirm">("input");
const busy = ref(false);

// "Everything" is the default for remove and move
const all = ref(props.action === "remove" || props.action === "move");
const amount = ref("");
const location = ref<string | null>(b.locationUuid);
// "me" or "<guildId>:<userId>": a member of an org you may give in
const recipient = ref<string | null>("me");

const unit = computed(() => b.unit);
const amt = computed(() => amountOf(amount.value, unit.value));

// Orgs you may share in or give to members of
const giveOrgs = computed(() => me.value?.orgs ?? []);

// Sharing: one switch per org; the ones it is shared in already are listed even while they take no writes
const shareIn = reactive(Object.fromEntries(b.sharedIn.map((g) => [g, true])) as Record<string, boolean>);
const shareOrgs = computed(() => {
  const ids = [...new Set([...giveOrgs.value.map((o) => o.guildId), ...b.sharedIn])];
  return ids.map((g) => ({ guildId: g, name: orgOf(g)?.name ?? "Org", canAdd: giveOrgs.value.some((o) => o.guildId === g) }));
});
const sharedNow = computed(() => shareOrgs.value.filter((o) => shareIn[o.guildId]).map((o) => o.guildId).sort());
const shareChanges = computed(() => sharedNow.value.join() !== [...b.sharedIn].sort().join());

// Recipients: you, then the members of every org you may give in (each person once, the org named
// when you are in more than one)
watch(giveOrgs, (orgs) => {
  if (props.action === "move") for (const o of orgs) ensureMembers(o.guildId);
}, { immediate: true });
const recipientOptions = computed(() => {
  const seen = new Set([me.value?.userId]);
  const others = giveOrgs.value.flatMap((o) => (members[o.guildId] ?? [])
    .filter((m) => !seen.has(m.userId) && seen.add(m.userId))
    .map((m) => ({ value: `${o.guildId}:${m.userId}`, label: giveOrgs.value.length > 1 ? `${memberLabel(m)} · ${o.name}` : memberLabel(m) })));
  return [{ value: "me", label: t("stock.me") }, ...others];
});
const giveTo = computed(() => {
  if (!recipient.value || recipient.value === "me") return null;
  const [guildId, userId] = recipient.value.split(":") as [string, string];
  return { guildId, userId, name: members[guildId]?.find((m) => m.userId === userId)?.displayName ?? "?" };
});

const moveChanges = computed(() => location.value !== b.locationUuid || !!giveTo.value);

const valid = computed(() => {
  switch (props.action) {
    case "remove": return all.value || !!amt.value;
    // "0" empties the batch: allowed here, unlike everywhere else
    case "adjust": return amount.value.trim() !== "" && (!!amt.value || /^0+([.,]0*)?$/.test(amount.value.trim()));
    case "move": return (all.value || !!amt.value) && !!location.value && !!recipient.value && moveChanges.value;
    // A part, not all of it (the server checks exactly)
    case "split": return !!amt.value && Number(amt.value) < Number(b.quantity);
    case "share": return shareChanges.value;
    case "merge": return true;
  }
  return false;
});

const counted = computed(() => amt.value ?? "0");
const amountText = computed(() => (all.value ? `${qty(b.quantity, b.unit)} (${t("stock.allOf")})` : qty(amt.value ?? "", unit.value)));
const shareText = (ids: string[]) => (ids.length ? ids.map((g) => orgOf(g)?.name ?? "Org").join(", ") : t("stock.notShared"));
// What stays in the batch after a split (display only)
const splitRest = computed(() => qty(String(Number(b.quantity) - Number(amt.value ?? 0)), b.unit));

// Where it ends: a give unshared with the recipient, else as it is
const targetText = computed(() => {
  const where = locations.value.get(location.value ?? "")?.short ?? b.location;
  return `${where} · ${giveTo.value ? giveTo.value.name : ownerText(b)}`;
});

const titles: Record<BatchAction, Parameters<typeof t>[0]> = {
  share: "field.sharing", split: "stock.split", merge: "stock.merge", remove: "stock.remove", move: "stock.move", adjust: "stock.adjust",
};
const icons: Record<BatchAction, IconName> = {
  share: "users", split: "split", merge: "merge", remove: "arrow-up", move: "move", adjust: "settings",
};
// Remove, adjust and merge apply right after their check; the others continue to it
const applies = props.action === "remove" || props.action === "adjust" || props.action === "merge";

const buttons = computed<ConfirmButton[]>(() => step.value === "input"
  ? [
      { label: t("common.cancel"), kind: "outline", value: "cancel" },
      { label: t(applies ? "common.apply" : "common.continue"), kind: "primary", value: "next", disabled: !valid.value },
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

async function book() {
  if (busy.value) return;
  busy.value = true;
  const typed = amount.value.trim();
  const what = `${b.material} · ${qText(b.quality)} · ${b.location}`;
  try {
    if (props.action === "remove") {
      const body: StockRemoveRequest = { batchId: b.id, amount: all.value ? null : typed, expected: b.quantity };
      await api<OkResponse>("/stock/remove", { method: "POST", body });
      toast(t("stock.removed", { what: `−${amountText.value} ${what} · ${ownerText(b)}` }));
    } else if (props.action === "adjust") {
      const body: StockAdjustRequest = { batchId: b.id, amount: typed, expected: b.quantity };
      await api<OkResponse>("/stock/adjust", { method: "POST", body });
      toast(t("stock.adjusted", { what: `${b.quantity} → ${qty(counted.value, b.unit)} ${what}` }));
    } else if (props.action === "share") {
      const body: StockShareRequest = { batchId: b.id, guildIds: sharedNow.value };
      await api<OkResponse>("/stock/share", { method: "POST", body });
      toast(t("stock.sharedToast", { what: `${what} → ${shareText(sharedNow.value)}` }));
    } else if (props.action === "merge") {
      const body: StockMergeRequest = { batchId: b.id, expected: b.quantity };
      await api<OkResponse>("/stock/merge", { method: "POST", body });
      toast(t("stock.mergeToast", { what: `${qty(b.quantity, b.unit)} ${what}` }));
    } else if (props.action === "split") {
      const body: StockSplitRequest = { batchId: b.id, amount: typed, expected: b.quantity };
      await api<OkResponse>("/stock/split", { method: "POST", body });
      toast(t("stock.splitToast", { what: `${qty(amt.value ?? "", unit.value)} ${what}` }));
    } else {
      const body: StockMoveRequest = { batchId: b.id, amount: all.value ? null : typed, expected: b.quantity };
      if (location.value !== b.locationUuid) body.toLocationUuid = location.value!;
      if (giveTo.value) {
        body.guildId = giveTo.value.guildId;
        body.toOwnerUserId = giveTo.value.userId;
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
    :icon="icons[action]"
    :buttons="buttons"
    @choose="choose"
  >
    <div v-if="step === 'input'" class="form single flush" @keydown.enter="onEnter">
      <div class="summary">
        <span class="big">{{ b.material }} · {{ qty(b.quantity, b.unit) }}</span>
        <span class="dim">{{ qText(b.quality) }} · {{ b.location }} · {{ ownerText(b) }}<template v-if="b.sharedIn.length"> · {{ sharedText(b) }}</template></span>
      </div>
      <div v-if="action === 'remove' || action === 'move'" class="field">
        {{ t("field.amount") }}
        <span class="with-unit">
          <label class="check"><input v-model="all" type="checkbox" /> {{ t("field.everything") }}</label>
          <input v-model="amount" class="input" :class="{ invalid: !all && amount.trim() !== '' && !amt }" type="text" inputmode="decimal" :disabled="all" />
          <span class="unit">{{ unitText(b.unit) }}</span>
        </span>
      </div>
      <label v-if="action === 'split'" class="field">
        {{ t("field.splitAmount") }}
        <span class="with-unit">
          <input v-model="amount" class="input" :class="{ invalid: amount.trim() !== '' && !valid }" type="text" inputmode="decimal" />
          <span class="unit">{{ unitText(b.unit) }}</span>
        </span>
      </label>
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
        <label v-if="recipientOptions.length > 1" class="field">
          {{ t("field.recipient") }}
          <Picker v-model="recipient" :options="recipientOptions" :placeholder="t('pick.member')" />
        </label>
      </template>
      <!-- Sharing: a switch per org; an org that takes no writes right now can only be switched off -->
      <div v-if="action === 'share'" class="field">
        {{ t("field.sharing") }}
        <label v-for="o in shareOrgs" :key="o.guildId" class="share-row">
          <input v-model="shareIn[o.guildId]" class="switch" type="checkbox" :disabled="!o.canAdd && !shareIn[o.guildId]" />
          <span class="share-org">{{ o.name }}</span>
        </label>
      </div>
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
      <template v-else-if="action === 'share'">
        <span class="big">{{ qty(b.quantity, b.unit) }} {{ b.material }} · {{ qText(b.quality) }}</span>
        <span><span class="dim">{{ t("stock.from") }}:</span> {{ shareText(b.sharedIn) }}</span>
        <span><span class="dim">{{ t("stock.to") }}:</span> {{ shareText(sharedNow) }}</span>
      </template>
      <template v-else-if="action === 'merge'">
        <span class="big">{{ qty(b.quantity, b.unit) }} {{ b.material }} · {{ qText(b.quality) }}</span>
        <span>{{ t("stock.mergeInto") }}</span>
      </template>
      <template v-else-if="action === 'split'">
        <span class="big">{{ qty(b.quantity, b.unit) }} {{ b.material }} · {{ qText(b.quality) }}</span>
        <span>{{ t("stock.splitInto", { a: splitRest, b: qty(amt ?? "", b.unit) }) }}</span>
      </template>
      <template v-else>
        <span class="big">{{ amountText }} {{ b.material }} · {{ qText(b.quality) }}</span>
        <span><span class="dim">{{ t("stock.from") }}:</span> {{ b.location }} · {{ ownerText(b) }}</span>
        <span><span class="dim">{{ t("stock.to") }}:</span> {{ targetText }}</span>
      </template>
    </div>
  </ConfirmDialog>
</template>
