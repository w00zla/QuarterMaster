<script setup lang="ts">
// The inventory scan (inventorySync.ts): in the head the location the warehouse or the inventory's
// storage belongs to (a searchable picker, kept, changeable while scanning: each location collects
// its own; the toggle left of it makes it follow Game.log, its tooltip names what was detected), the Scan button (start/stop the session; the user then hovers every stack in the freight
// manager's warehouse and every component in the character inventory's storage pane) and "Register
// all"; below it the kind filter (what the scan detects), then the proposals of every location as a
// compact table, one per stack or component (kind, resource, location, quality, amount; a
// component's stats after its name: Register / Discard). Registering (one or all, each at its own
// location) asks first, with a switch per org to share right away. The overlay shows the current
// location's only. The sightings behind the proposals, also the incomplete ones, are in the debug
// window (settings).
import { computed, ref, watchEffect } from "vue";
import Icon from "../../../adminapp/src/components/Icon.vue";
import Tooltip from "../../../adminapp/src/components/Tooltip.vue";
import { statValueText } from "../../../src/stock/component-stats";
import ConfirmDialog, { type ConfirmButton } from "../../../webapp/src/components/ConfirmDialog.vue";
import Picker from "../../../webapp/src/components/Picker.vue";
import type { ComponentProposal } from "../components";
import { t } from "../i18n";
import type { Proposal } from "../inventory";
import {
  accept, acceptComponent, autoLocation, componentProposals, componentSightings, dismiss, KIND_CLASS, KIND_ICON, KINDS, kinds, locationUuid, loggedLocation, loggedLocationUuid, proposals,
  setLocation, shareGuildIds, sightings, startInventoryScan, stopInventoryScan, toggleAutoLocation, toggleKind,
  type Kind, type Located,
} from "../inventorySync";
import { overlayOn, overlayRows, tabCounts } from "../overlay";
import { materialName, syncCatalog } from "../refinerySync";
import { scanMode } from "../scan";
import { connected, meOrgs } from "../state";
import { toast } from "../toasts";

// One row per proposal: a stack (materials, items) or a component
interface Row {
  kind: Kind;
  id: string;
  name: string;
  // A component's stats ("Coolant Rating +12.5 %"), or "no stats"
  detail: string | null;
  locationUuid: string;
  location: string;
  quality: string;
  amount: string;
  stack: Located<Proposal> | null;
  component: Located<ComponentProposal> | null;
}

const scanning = computed(() => scanMode.value === "inventory");
// Connected, but the catalog is not there yet (thin line): picker and Scan wait for it
const catalogPending = computed(() => connected.value && !syncCatalog.value);
const locationOptions = computed(() => (syncCatalog.value?.locations ?? []).map((l) => ({ value: l.uuid, label: l.short })));
const locationName = (uuid: string) => syncCatalog.value?.locations.find((l) => l.uuid === uuid)?.short ?? "?";

const amount = (value: string, unit: "SCU" | "pcs") => (unit === "SCU" ? `${value} SCU` : t("inventory.pieces", { n: value }));
// Every stat the tooltip showed, in the catalog's order, as its gain: "Coolant Rating +12.5 % · Integrity ±0.0 %";
// "no stats" only when the tooltip showed none (weapons, event items)
function statsText(p: ComponentProposal): string {
  const defs = syncCatalog.value?.components.components.find((c) => c.uuid === p.componentUuid)?.stats ?? [];
  const parts = defs.filter((s) => p.readStats.includes(s.uuid) || s.uuid in p.stats).map((s) => `${s.name} ${statValueText(s.kind, p.stats[s.uuid] ?? "0")}`);
  return parts.length ? parts.join(" · ") : t("components.noStats");
}
const rows = computed<Row[]>(() => [
  ...proposals.value.map((p): Row => ({
    kind: p.unit === "SCU" ? "mats" : "items", id: p.id, name: materialName(p.materialUuid), detail: null, locationUuid: p.locationUuid, location: locationName(p.locationUuid),
    quality: String(p.quality), amount: amount(p.amount, p.unit), stack: p, component: null,
  })),
  ...componentProposals.value.map((p): Row => ({
    kind: "comps", id: p.id, name: p.label, detail: statsText(p), locationUuid: p.locationUuid, location: locationName(p.locationUuid),
    quality: "–", amount: t("inventory.pieces", { n: 1 }), stack: null, component: p,
  })),
]);
const what = (r: Row) => [r.name, r.detail ?? r.quality, r.amount].join(" · ");
const tagClass: Record<Kind, string> = KIND_CLASS;
const kindIcon = KIND_ICON;
// The scan overlay shows the current location's rows, the most recently seen first (stacks and components mixed)
watchEffect(() => {
  const seen = new Map([...sightings.value, ...componentSightings.value].map((s) => [s.key, s.atMs]));
  overlayRows.inventory = rows.value
    .filter((r) => r.locationUuid === locationUuid.value)
    .sort((a, b) => (seen.get(b.id) ?? 0) - (seen.get(a.id) ?? 0))
    .map((r) => ({ tag: "", icon: kindIcon[r.kind], cls: tagClass[r.kind], name: r.name, detail: r.detail, cols: [r.quality, r.amount] }));
  tabCounts.inventory = rows.value.length;
});

// The register dialog: one row, or all of them
const registering = ref<Row[] | null>(null);
const busy = ref(false);
const registerButtons = computed<ConfirmButton[]>(() => [
  { label: t("common.cancel"), kind: "outline", value: "cancel" },
  { label: t("inventory.register"), kind: "primary", value: "add", icon: "check", disabled: busy.value || !connected.value },
]);
// The dialog's title names the location when all rows share one
const registeringTitle = computed(() => {
  const list = registering.value ?? [];
  const places = new Set(list.map((r) => r.locationUuid));
  if (places.size > 1) return t("inventory.confirmAddMany", { n: list.length, count: places.size });
  const location = list[0] ? list[0].location : "?";
  return list.length === 1 ? t("inventory.confirmOne", { location }) : t("inventory.confirmAdd", { n: list.length, location });
});
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
    for (const r of list) {
      const ok = r.stack ? await accept(r.stack) : await acceptComponent(r.component!);
      if (!ok) break;
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

// The auto toggle's tooltip: what it does, or while on what Game.log named last
const autoTip = computed(() => {
  if (!autoLocation.value) return t("inventory.autoLocation");
  if (!loggedLocation.value) return t("inventory.autoLocationNone");
  return loggedLocationUuid.value
    ? t("inventory.autoLocationOn", { name: locationName(loggedLocationUuid.value) })
    : t("inventory.autoLocationOther", { key: loggedLocation.value });
});

function toggleScan() {
  if (scanning.value) void stopInventoryScan();
  else void startInventoryScan();
}
</script>

<template>
  <section class="panel inventory">
    <div class="head">
      <span class="head-title">{{ t("inventory.title") }} <span class="head-count">{{ rows.length }}</span></span>
      <Tooltip :text="autoTip">
        <button type="button" class="btn small outline square auto" :class="{ active: autoLocation }" :aria-pressed="autoLocation" @click="toggleAutoLocation">
          <Icon name="locate" :size="14" />
        </button>
      </Tooltip>
      <Picker
        class="location" :model-value="locationUuid" :options="locationOptions" :disabled="catalogPending"
        :placeholder="t(catalogPending ? 'load.catalogPending' : 'inventory.location')" @update:model-value="setLocation"
      />
      <Tooltip :text="overlayOn ? t('overlay.controls') : catalogPending ? t('load.catalogPending') : !locationUuid ? t('inventory.pickLocation') : null">
        <button type="button" class="btn small outline" :disabled="!locationUuid || !connected || overlayOn || catalogPending" @click="toggleScan">
          <Icon :name="scanning ? 'eye-off' : 'eye'" :size="14" /> {{ t(scanning ? "scan.stop" : "scan.start") }}
        </button>
      </Tooltip>
      <Tooltip :text="lockTip">
        <button type="button" class="btn small primary" :disabled="!connected || !rows.length || busy" @click="registering = [...rows]">
          <Icon name="check" :size="14" /> {{ t("inventory.addAll") }}
        </button>
      </Tooltip>
    </div>
    <!-- What the scan detects -->
    <div class="chips filter">
      <span class="filter-label">{{ t("inventory.scanned") }}</span>
      <button v-for="k in KINDS" :key="k" type="button" class="chip" :class="[tagClass[k], { active: kinds.has(k) }]" :aria-pressed="kinds.has(k)" @click="toggleKind(k)">
        <Icon :name="kindIcon[k]" :size="12" /> {{ t(`inventory.kind.${k}`) }}
        <Icon v-if="kinds.has(k)" name="check" :size="12" />
      </button>
    </div>
    <div v-if="!rows.length" class="empty-line">
      {{ t(scanning ? "inventory.hover" : "inventory.empty") }}
    </div>
    <template v-else>
      <div class="row table-head">
        <span />
        <span>{{ t("col.material") }}</span>
        <span>{{ t("col.location") }}</span>
        <span class="num">{{ t("col.quality") }}</span>
        <span class="num">{{ t("col.amount") }}</span>
        <span />
        <span />
      </div>
      <!-- Only the rows scroll: head, filter and column titles stay -->
      <div class="rows">
        <div v-for="r in rows" :key="r.id" class="row">
          <Tooltip :text="t(`inventory.kind.${r.kind}`)">
            <span class="tag kind" :class="tagClass[r.kind]"><Icon :name="kindIcon[r.kind]" :size="12" /></span>
          </Tooltip>
          <span class="row-name">{{ r.name }}<span v-if="r.detail" class="detail"> · {{ r.detail }}</span></span>
          <span class="row-place">{{ r.location }}</span>
          <span class="num">{{ r.quality }}</span>
          <span class="num">{{ r.amount }}</span>
          <Tooltip :text="t('inventory.register')">
            <button type="button" class="icon-btn" :disabled="!connected || busy" @click="registering = [r]"><Icon name="check" :size="14" /></button>
          </Tooltip>
          <Tooltip :text="t('inventory.drop')">
            <button type="button" class="icon-btn" @click="dismiss(r.id)"><Icon name="close" :size="14" /></button>
          </Tooltip>
        </div>
      </div>
    </template>
    <ConfirmDialog
      v-if="registering"
      :title="registeringTitle"
      icon="plus"
      :buttons="registerButtons"
      @choose="onRegister"
    >
      <div class="confirm">
        <div v-for="r in registering" :key="r.id" class="confirm-row">
          <span class="row-name">{{ r.name }}<span v-if="r.detail" class="detail"> · {{ r.detail }}</span></span>
          <span class="row-place">{{ r.location }}</span>
          <span class="num">{{ r.quality }}</span>
          <span class="num">{{ r.amount }}</span>
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
/* Fills the main area, only its rows scroll; the picker's list must reach past the panel (ui.css
   clips panels) */
.inventory {
  flex: 1;
  min-height: 0;
  overflow: visible;
}

.rows {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  border-top: 1px solid var(--border-dim);
}

.location {
  flex: 1;
  min-width: 140px;
  max-width: 260px;
}

/* The auto location toggle: on = accent like the kind chips */
.auto.active {
  border-color: color-mix(in srgb, var(--accent) 45%, transparent);
  background: color-mix(in srgb, var(--accent) 14%, transparent);
  color: var(--accent);
}

/* The kind filter below the head: a label, then compact chips with an icon */
.filter {
  align-items: center;
  gap: 6px;
  padding: 4px 16px 8px;
  font-size: 11px;
}

.filter-label {
  color: var(--text-2);
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}

/* Toggles: on = the kind's badge colour with a check, off = dashed and dimmed */
.filter .chip {
  --kind: var(--text-2);
  height: 22px;
  gap: 4px;
  padding: 0 8px;
  font-size: 11px;
  border-style: dashed;
  color: var(--text-3);
}

.filter .chip.ok {
  --kind: var(--ok);
}

.filter .chip.accent {
  --kind: var(--accent);
}

.filter .chip.active {
  border-style: solid;
  border-color: color-mix(in srgb, var(--kind) 45%, transparent);
  background: color-mix(in srgb, var(--kind) 14%, transparent);
  color: var(--kind);
}

/* One compact row per stack or component, like the refinery's rows: kind badge, resource, quality, amount, two icon buttons */
.row {
  display: grid;
  grid-template-columns: 24px minmax(0, 1fr) minmax(0, 110px) 40px 88px 24px 24px;
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

/* The kind badge: its icon only (the tooltip names it) */
.tag.kind {
  padding: 0 5px;
}

.row-name,
.row-place {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.row .row-name {
  color: var(--text);
}

/* A component's stats after its name */
.detail {
  color: var(--text-2);
}

.num {
  text-align: right;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

/* The register dialog: the rows, then the share switches */
.confirm {
  display: flex;
  flex-direction: column;
  gap: 6px;
  font-size: 12px;
  color: var(--text-2);
}

.confirm-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 110px) 40px 88px;
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
