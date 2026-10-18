<script setup lang="ts">
// The ship component scan (componentsSync.ts): in the head the location the inventory's storage
// belongs to (a searchable picker, kept), the Scan button (start/stop the session; the user then
// hovers every component in the character inventory's storage pane) and "Register all"; below the
// proposals as a compact table, one per tile (component, the gains read off the tooltip: Register /
// Discard), then the sightings that yield none (unknown component, unreadable stats) with the reason,
// to discard. Registering (one or all) asks first, with a switch per org to share right away (the
// warehouse scan's choice).
import { computed, ref } from "vue";
import Icon from "../../../adminapp/src/components/Icon.vue";
import Tooltip from "../../../adminapp/src/components/Tooltip.vue";
import { statValueText } from "../../../src/stock/component-stats";
import ConfirmDialog, { type ConfirmButton } from "../../../webapp/src/components/ConfirmDialog.vue";
import Picker from "../../../webapp/src/components/Picker.vue";
import type { ComponentProposal } from "../components";
import { accept, dismiss, locationUuid, problems, proposals, setLocation, startComponentsScan, stopComponentsScan } from "../componentsSync";
import { t } from "../i18n";
import { shareGuildIds } from "../inventorySync";
import { syncCatalog } from "../refinerySync";
import { scanMode } from "../scan";
import { connected, meOrgs } from "../state";
import { toast } from "../toasts";

const scanning = computed(() => scanMode.value === "components");
const locationOptions = computed(() => (syncCatalog.value?.locations ?? []).map((l) => ({ value: l.uuid, label: l.short })));
const locationLabel = computed(() => syncCatalog.value?.locations.find((l) => l.uuid === locationUuid.value)?.short ?? "?");

// "Coolant Rating +12.5 % · Integrity +2.0 %" in the catalog's order, or "no stats"
function statsText(p: ComponentProposal): string {
  const defs = syncCatalog.value?.components.components.find((c) => c.uuid === p.componentUuid)?.stats ?? [];
  const parts = defs.filter((s) => s.uuid in p.stats).map((s) => `${s.name} ${statValueText(s.kind, p.stats[s.uuid]!)}`);
  return parts.length ? parts.join(" · ") : t("components.noStats");
}
const problemText = (problem: string, unreadable: string[]) =>
  problem === "statsUnreadable" ? `${t("components.statsUnreadable")}: ${unreadable.join(", ")}` : t(problem === "ambiguousComponent" ? "components.ambiguous" : "components.unknown");

// The register dialog: one proposal, or all of them
const registering = ref<ComponentProposal[] | null>(null);
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
    if (done === 1 && list.length === 1) toast(t("components.registered", { what: `${list[0]!.label} · ${statsText(list[0]!)}` }));
    else if (done) toast(t("components.added", { n: done }));
    busy.value = false;
    registering.value = null;
  }
}

const lockTip = computed(() => (connected.value ? null : t("conn.off")));

function toggleScan() {
  if (scanning.value) void stopComponentsScan();
  else void startComponentsScan();
}
</script>

<template>
  <section class="panel components">
    <div class="head">
      <Icon name="type-module" :size="16" />
      <span class="head-title">{{ t("components.title") }}</span>
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
    <div v-if="!proposals.length && !problems.length" class="empty-line">
      {{ t(scanning ? "components.hover" : "components.empty") }}
    </div>
    <template v-else>
      <div class="row table-head">
        <span>{{ t("col.component") }}</span>
        <span>{{ t("col.stats") }}</span>
        <span />
        <span />
      </div>
      <div v-for="p in proposals" :key="p.id" class="row">
        <span class="row-name">{{ p.label }}</span>
        <span class="stats">{{ statsText(p) }}</span>
        <Tooltip :text="t('inventory.register')">
          <button type="button" class="icon-btn" :disabled="!connected || busy" @click="registering = [p]"><Icon name="check" :size="14" /></button>
        </Tooltip>
        <Tooltip :text="t('inventory.drop')">
          <button type="button" class="icon-btn" @click="dismiss(p.id)"><Icon name="close" :size="14" /></button>
        </Tooltip>
      </div>
      <div v-for="s in problems" :key="s.key" class="row problem">
        <span class="row-name">{{ s.title }}</span>
        <span class="stats">{{ problemText(s.problem!, s.unreadable) }}</span>
        <span />
        <Tooltip :text="t('inventory.drop')">
          <button type="button" class="icon-btn" @click="dismiss(s.key)"><Icon name="close" :size="14" /></button>
        </Tooltip>
      </div>
    </template>
    <ConfirmDialog
      v-if="registering"
      :title="registering.length === 1 ? t('components.confirmOne', { location: locationLabel }) : t('components.confirmAdd', { n: registering.length, location: locationLabel })"
      icon="plus"
      :buttons="registerButtons"
      @choose="onRegister"
    >
      <div class="confirm">
        <div v-for="p in registering" :key="p.id" class="confirm-row">
          <span class="row-name">{{ p.label }}</span>
          <span class="stats">{{ statsText(p) }}</span>
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
.components {
  flex-shrink: 0;
  margin-bottom: 12px;
  overflow: visible;
}

.location {
  flex: 1;
  min-width: 140px;
  max-width: 260px;
}

/* One compact row per tile, like the warehouse's rows: component, stats, two icon buttons */
.row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr) 24px 24px;
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

.row-name,
.stats {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.row .row-name {
  color: var(--text);
}

/* A sighting without a proposal: the title as read, the reason in place of the stats */
.row.problem .row-name,
.row.problem .stats {
  color: var(--text-3);
}

/* The register dialog: the components, then the share switches */
.confirm {
  display: flex;
  flex-direction: column;
  gap: 6px;
  font-size: 12px;
  color: var(--text-2);
}

.confirm-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
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
