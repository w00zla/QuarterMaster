<script setup lang="ts">
// The inventory scan (inventorySync.ts): in the head the location the warehouse belongs to (a
// searchable picker, kept), the Scan button (start/stop the session; the user then hovers every
// stack in the freight manager's warehouse) and "Register all"; below the proposals as a compact
// table, one per stack (kind, resource, quality, amount: Register / Discard). Registering (one or
// all) asks first, with a switch per org to share the stacks there right away. The sightings behind
// the proposals, also the incomplete ones, are in the debug window (settings).
import { computed, ref } from "vue";
import Icon from "../../../adminapp/src/components/Icon.vue";
import Tooltip from "../../../adminapp/src/components/Tooltip.vue";
import ConfirmDialog, { type ConfirmButton } from "../../../webapp/src/components/ConfirmDialog.vue";
import Picker from "../../../webapp/src/components/Picker.vue";
import { t } from "../i18n";
import type { Proposal } from "../inventory";
import { accept, dismiss, locationUuid, proposals, setLocation, shareGuildIds, startInventoryScan, stopInventoryScan } from "../inventorySync";
import { materialName, syncCatalog } from "../refinerySync";
import { scanMode } from "../scan";
import { connected, meOrgs } from "../state";
import { toast } from "../toasts";

const scanning = computed(() => scanMode.value === "inventory");
const locationOptions = computed(() => (syncCatalog.value?.locations ?? []).map((l) => ({ value: l.uuid, label: l.short })));
const locationLabel = computed(() => syncCatalog.value?.locations.find((l) => l.uuid === locationUuid.value)?.short ?? "?");

const amount = (value: string, unit: "SCU" | "pcs") => (unit === "SCU" ? `${value} SCU` : t("inventory.pieces", { n: value }));
const what = (p: Proposal) => `${materialName(p.materialUuid)} · ${p.quality} · ${amount(p.amount, p.unit)}`;

// The register dialog: one proposal, or all of them
const registering = ref<Proposal[] | null>(null);
const busy = ref(false);
const registerButtons = computed<ConfirmButton[]>(() => [
  { label: t("common.cancel"), kind: "outline", value: "cancel" },
  { label: t("inventory.register"), kind: "primary", value: "add", icon: "check", disabled: busy.value || !connected.value },
]);
const shared = (guildId: string) => shareGuildIds.value.includes(guildId);
function toggleShare(guildId: string) {
  shareGuildIds.value = shared(guildId) ? shareGuildIds.value.filter((g) => g !== guildId) : [...shareGuildIds.value, guildId];
}

async function onRegister(value: string) {
  const list = registering.value;
  if (value !== "add" || !list) return void (registering.value = null);
  busy.value = true;
  let done = 0;
  try {
    for (const p of list) {
      if (!(await accept(p))) break;
      done++;
    }
  } finally {
    if (done === 1 && list.length === 1) toast(t("inventory.registered", { what: what(list[0]!) }));
    else if (done) toast(t("inventory.added", { n: done }));
    busy.value = false;
    registering.value = null;
  }
}

const lockTip = computed(() => (connected.value ? null : t("conn.off")));

function toggleScan() {
  if (scanning.value) void stopInventoryScan();
  else void startInventoryScan();
}
</script>

<template>
  <section class="panel inventory">
    <div class="head">
      <Icon name="item" :size="16" />
      <span class="head-title">{{ t("inventory.title") }}</span>
      <Picker class="location" :model-value="locationUuid" :options="locationOptions" :placeholder="t('inventory.location')" :disabled="scanning" @update:model-value="setLocation" />
      <Tooltip :text="!locationUuid ? t('inventory.pickLocation') : null">
        <button type="button" class="btn small outline" :disabled="!locationUuid || !connected" @click="toggleScan">
          <Icon :name="scanning ? 'eye-off' : 'eye'" :size="14" /> {{ t(scanning ? "scan.stop" : "scan.start") }}
        </button>
      </Tooltip>
      <Tooltip :text="lockTip">
        <button type="button" class="btn small primary" :disabled="!connected || !proposals.length || busy" @click="registering = [...proposals]">
          <Icon name="check" :size="14" /> {{ t("inventory.addAll") }}
        </button>
      </Tooltip>
    </div>
    <div v-if="!proposals.length" class="empty-line">
      {{ t(scanning ? "inventory.hover" : "inventory.empty") }}
    </div>
    <template v-else>
      <div class="row table-head">
        <span />
        <span>{{ t("col.material") }}</span>
        <span class="num">{{ t("col.quality") }}</span>
        <span class="num">{{ t("col.amount") }}</span>
        <span />
        <span />
      </div>
      <div v-for="p in proposals" :key="p.id" class="row">
        <span class="tag" :class="p.unit === 'SCU' ? 'ok' : ''">{{ t(p.unit === "SCU" ? "inventory.kind.mats" : "inventory.kind.items") }}</span>
        <span class="row-name">{{ materialName(p.materialUuid) }}</span>
        <span class="num">{{ p.quality }}</span>
        <span class="num">{{ amount(p.amount, p.unit) }}</span>
        <Tooltip :text="t('inventory.register')">
          <button type="button" class="icon-btn" :disabled="!connected || busy" @click="registering = [p]"><Icon name="check" :size="14" /></button>
        </Tooltip>
        <Tooltip :text="t('inventory.drop')">
          <button type="button" class="icon-btn" @click="dismiss(p)"><Icon name="close" :size="14" /></button>
        </Tooltip>
      </div>
    </template>
    <ConfirmDialog
      v-if="registering"
      :title="registering.length === 1 ? t('inventory.confirmOne', { location: locationLabel }) : t('inventory.confirmAdd', { n: registering.length, location: locationLabel })"
      icon="plus"
      :buttons="registerButtons"
      @choose="onRegister"
    >
      <div class="confirm">
        <div v-for="p in registering" :key="p.id" class="confirm-row">
          <span class="row-name">{{ materialName(p.materialUuid) }}</span>
          <span class="num">{{ p.quality }}</span>
          <span class="num">{{ amount(p.amount, p.unit) }}</span>
        </div>
        <div v-if="meOrgs.length" class="share">
          <div class="share-title">{{ t("inventory.shareTitle") }}</div>
          <label v-for="o in meOrgs" :key="o.guildId" class="share-row">
            <input type="checkbox" :checked="shared(o.guildId)" @change="toggleShare(o.guildId)" />
            <span>{{ o.name }}</span>
          </label>
        </div>
      </div>
    </ConfirmDialog>
  </section>
</template>

<style scoped>
/* The picker's list must reach past the panel (ui.css clips panels) */
.inventory {
  flex-shrink: 0;
  margin-bottom: 12px;
  overflow: visible;
}

.location {
  flex: 1;
  min-width: 140px;
  max-width: 260px;
}

/* One compact row per stack, like the refinery's rows: kind, resource, quality, amount, two icon buttons */
.row {
  display: grid;
  grid-template-columns: 52px minmax(0, 1fr) 40px 88px 24px 24px;
  align-items: center;
  gap: 8px;
  min-height: 28px;
  padding: 2px 16px;
  font-size: 12px;
  line-height: 1.35;
  color: var(--text-2);
}

.row + .row {
  border-top: 1px solid var(--border-dim);
}

.table-head {
  min-height: 22px;
  padding-top: 6px;
  border-top: 1px solid var(--border-dim);
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}

.row .tag {
  justify-self: start;
}

.row-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.row .row-name {
  color: var(--text);
}

.num {
  text-align: right;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

/* The register dialog: the stacks, then the share switches */
.confirm {
  display: flex;
  flex-direction: column;
  gap: 6px;
  font-size: 12px;
  color: var(--text-2);
}

.confirm-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 40px 88px;
  gap: 8px;
}

.share {
  margin-top: 8px;
  padding-top: 8px;
  border-top: 1px solid var(--border-dim);
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.share-title {
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}

.share-row {
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--text);
  cursor: pointer;
}
</style>
