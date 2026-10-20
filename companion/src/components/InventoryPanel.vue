<script setup lang="ts">
// The inventory scan's proposals (inventorySync.ts; scan and location are in the scan row,
// ScanBar.vue), one panel per part: stock (the user hovers every stack in the freight manager's
// warehouse) and comps (every component in the character inventory's storage pane). "Register all" in
// the head, after the count the part's kind filter (what the scan detects; off: its screen is not read), then
// the proposals of every location as a compact table with resizable columns, one row per stack (kind,
// name, quality, amount, location) or component (name, type, size, grade, stats, location), each with
// Register / Discard. Registering (one or all, each at
// its own location) asks first, with a switch per org to share right away. The overlay shows the
// current location's only. The sightings behind the proposals, also the incomplete ones, are in the
// debug window (settings). Without proposals: one line, how to get them as a quiet hint below.
import { computed, ref, watchEffect } from "vue";
import ColumnHead from "../../../adminapp/src/components/ColumnHead.vue";
import Icon from "../../../adminapp/src/components/Icon.vue";
import Tooltip from "../../../adminapp/src/components/Tooltip.vue";
import { useTableColumns, type ColumnSpec } from "../../../adminapp/src/tableColumns";
import { statValueText } from "../../../src/stock/component-stats";
import ConfirmDialog, { type ConfirmButton } from "../../../webapp/src/components/ConfirmDialog.vue";
import type { ComponentProposal } from "../components";
import { langRef, t } from "../i18n";
import type { Proposal } from "../inventory";
import {
  accept, acceptComponent, componentProposals, componentSightings, dismiss, KIND_CLASS, KIND_ICON, kinds, locationUuid, proposals,
  shareGuildIds, sightings, toggleKind, type Kind, type Located,
} from "../inventorySync";

const props = defineProps<{ part: "stock" | "comps" }>();
const stock = props.part === "stock";
// The kinds this part's filter switches
const partKinds: Kind[] = stock ? ["mats", "items"] : ["comps"];
import { overlayRows, tabCounts } from "../overlay";
import { catalogResponses, materialName, syncCatalog } from "../refinerySync";
import { connected, meOrgs } from "../state";
import { toast } from "../toasts";

// One row per proposal: a stack (materials, items) or a component
interface Row {
  kind: Kind;
  id: string;
  name: string;
  // From the catalog where it has them (components, items): "Cooler", "S3", "A"
  type: string;
  size: string;
  grade: string;
  // A component's stats ("Coolant Rating +12.5 %"), or "no stats"
  detail: string | null;
  locationUuid: string;
  location: string;
  quality: string;
  amount: string;
  stack: Located<Proposal> | null;
  component: Located<ComponentProposal> | null;
}

const locationName = (uuid: string) => syncCatalog.value?.locations.find((l) => l.uuid === uuid)?.short ?? "?";

const amount = (value: string, unit: "SCU" | "pcs") => (unit === "SCU" ? `${value} SCU` : t("inventory.pieces", { n: value }));
// Every stat the tooltip showed, in the catalog's order, as its gain: "Coolant Rating +12.5 % · Integrity ±0.0 %";
// a dash only when the tooltip showed none (weapons, event items)
function statsText(p: ComponentProposal): string {
  const defs = syncCatalog.value?.components.components.find((c) => c.uuid === p.componentUuid)?.stats ?? [];
  const parts = defs.filter((s) => p.readStats.includes(s.uuid) || s.uuid in p.stats).map((s) => `${s.name} ${statValueText(s.kind, p.stats[s.uuid] ?? "0")}`);
  return parts.length ? parts.join(" · ") : "–";
}
// The catalog's components in the UI language (name, type, size, grade). Items show none of these: every
// bookable one is of the type "Misc." (checked 2026-10-20), their size says nothing
const catalogMaterials = computed(() => {
  const r = catalogResponses.value;
  return new Map((r ? (langRef.value === "de" ? r.de : r.en).materials : []).map((m) => [m.uuid, m]));
});
function described(uuid: string) {
  const m = catalogMaterials.value.get(uuid);
  return { type: m?.typeLabel ?? "", size: m?.size ? `S${m.size}` : "", grade: m?.gradeLetter ?? "" };
}
const rows = computed<Row[]>(() => stock
  ? proposals.value.map((p): Row => ({
    kind: p.unit === "SCU" ? "mats" : "items", id: p.id, name: materialName(p.materialUuid), type: "", size: "", grade: "", detail: null,
    locationUuid: p.locationUuid, location: locationName(p.locationUuid), quality: String(p.quality), amount: amount(p.amount, p.unit), stack: p, component: null,
  }))
  // No quality (the register dialog's column stays empty)
  : componentProposals.value.map((p): Row => ({
    kind: "comps", id: p.id, name: catalogMaterials.value.get(p.componentUuid)?.name ?? p.label, ...described(p.componentUuid), detail: statsText(p),
    locationUuid: p.locationUuid, location: locationName(p.locationUuid), quality: "", amount: t("inventory.pieces", { n: 1 }), stack: null, component: p,
  })));

// The table's columns (widths kept per table; no sorting: the newest come first); the location last,
// it takes the room left. Stacks: kind, quality and amount; components: catalog data and stats
const columns = computed<ColumnSpec[]>(() => [
  ...(stock ? [{ key: "kind", label: "", width: 20, fixed: true, sortable: false }] : []),
  { key: "name", label: t("debug.col.name"), width: 120, sortable: false },
  ...(stock
    ? [
      { key: "quality", label: t("col.quality"), width: 40, sortable: false },
      { key: "amount", label: t("col.amount"), width: 60, sortable: false },
    ]
    : [
      { key: "type", label: t("col.type"), width: 70, sortable: false },
      { key: "size", label: t("col.size"), width: 40, sortable: false },
      { key: "grade", label: t("col.grade"), width: 40, sortable: false },
      { key: "stats", label: t("col.stats"), width: 120, sortable: false },
    ]),
  { key: "location", label: t("col.location"), width: 80, sortable: false },
  // The action buttons: as wide as an icon button, always; a line before them in the head
  { key: "register", label: "", width: 26, fixed: true, sortable: false, sep: true },
  { key: "drop", label: "", width: 26, fixed: true, sortable: false },
]);
// The rows' column gap (.row below)
const ROW_GAP = 8;
const cols = useTableColumns(`qm.companion.${props.part}.columns`, columns, { key: "name", dir: "asc" }, ROW_GAP);
const what = (r: Row) => [r.name, r.detail ?? r.quality, r.amount].join(" · ");
const tagClass: Record<Kind, string> = KIND_CLASS;
const kindIcon = KIND_ICON;
// The scan overlay shows the current location's rows, the most recently seen first
watchEffect(() => {
  const seen = new Map((stock ? sightings.value : componentSightings.value).map((s) => [s.key, s.atMs]));
  overlayRows[props.part] = rows.value
    .filter((r) => r.locationUuid === locationUuid.value)
    .sort((a, b) => (seen.get(b.id) ?? 0) - (seen.get(a.id) ?? 0))
    // A component: its name and stats; a stack: its name, quality and amount
    .map((r) => ({ tag: "", icon: kindIcon[r.kind], cls: tagClass[r.kind], name: r.name, detail: r.detail, cols: r.component ? [] : [r.quality, r.amount] }));
  tabCounts[props.part] = rows.value.length;
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
</script>

<template>
  <section class="panel inventory">
    <div class="head">
      <span class="head-title no-grow">{{ t(`${part}.title`) }} <span class="head-count">{{ rows.length }}</span></span>
      <!-- What the scan detects -->
      <div class="chips filter">
        <Tooltip v-for="k in partKinds" :key="k" :text="t(kinds.has(k) ? 'filter.on' : 'filter.off')">
          <button type="button" class="chip" :class="[tagClass[k], { active: kinds.has(k) }]" :aria-pressed="kinds.has(k)" @click="toggleKind(k)">
            <Icon :name="kindIcon[k]" :size="12" /> {{ t(`inventory.kind.${k}`) }}
            <Icon :name="kinds.has(k) ? 'check' : 'close'" :size="12" />
          </button>
        </Tooltip>
      </div>
      <span class="spacer" />
      <Tooltip :text="lockTip">
        <button type="button" class="btn small primary" :disabled="!connected || !rows.length || busy" @click="registering = [...rows]">
          <Icon name="check" :size="14" /> {{ t("inventory.addAll") }}
        </button>
      </Tooltip>
    </div>
    <div v-if="!rows.length" class="empty-line">
      {{ t(`${part}.empty`) }}
      <div class="empty-hint">{{ t(`${part}.emptyHint`) }}</div>
    </div>
    <div v-else class="table" :style="{ '--cols': cols.template.value }">
      <ColumnHead class="table-head" :columns="columns" :sort="cols.sort.value" @resize="cols.startResize" @reset="cols.resetWidth" />
      <!-- Only the rows scroll: head, filter and column titles stay. The widths fit the rows' box (its
           vertical scrollbar left out: measured on the table, the rows scrolled sideways after a resize) -->
      <div :ref="cols.observe" class="rows">
        <div v-for="r in rows" :key="r.id" class="row">
          <span v-if="stock" class="tag kind" :class="tagClass[r.kind]"><Icon :name="kindIcon[r.kind]" :size="11" /></span>
          <span class="cell row-name">{{ r.name }}</span>
          <template v-if="stock">
            <span class="num">{{ r.quality }}</span>
            <span class="num">{{ r.amount }}</span>
          </template>
          <template v-else>
            <span class="cell">{{ r.type }}</span>
            <span class="cell">{{ r.size }}</span>
            <span class="cell">{{ r.grade }}</span>
            <span class="cell">{{ r.detail }}</span>
          </template>
          <span class="cell">{{ r.location }}</span>
          <Tooltip :text="t('inventory.register')">
            <button type="button" class="icon-btn" :disabled="!connected || busy" @click="registering = [r]"><Icon name="check" :size="14" /></button>
          </Tooltip>
          <Tooltip :text="t('inventory.drop')">
            <button type="button" class="icon-btn" @click="dismiss(r.id)"><Icon name="close" :size="14" /></button>
          </Tooltip>
        </div>
      </div>
    </div>
    <ConfirmDialog
      v-if="registering"
      :title="registeringTitle"
      icon="plus"
      :buttons="registerButtons"
      @choose="onRegister"
    >
      <div class="confirm">
        <div v-for="r in registering" :key="r.id" class="confirm-row">
          <span class="cell row-name">{{ r.name }}<span v-if="r.detail" class="detail"> · {{ r.detail }}</span></span>
          <span class="cell">{{ r.location }}</span>
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
/* Below the empty text: how to get proposals, small and quiet */
.empty-hint {
  max-width: 420px;
  margin: 6px auto 0;
  font-size: 11px;
  opacity: 0.75;
}

/* Fills the main area, only its rows scroll */
.inventory {
  flex: 1;
  min-height: 0;
  overflow: visible;
}

.rows {
  flex: 1;
  min-height: 0;
  overflow-x: hidden;
  overflow-y: auto;
  border-top: 1px solid var(--border-dim);
}

/* The kind filter in the head after the count: compact chips with an icon (what they do in their tooltip) */
.filter {
  align-items: center;
  gap: 6px;
  font-size: 11px;
}

/* Toggles: on = the kind's badge colour with a check, off = dashed and dimmed with an x */
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

/* The column titles and the rows: the rows scroll */
.table {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

/* One compact row per stack or component, like the refinery's rows; the columns from useTableColumns
   (--cols), the gap as ROW_GAP */
.row {
  display: grid;
  grid-template-columns: var(--cols);
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
  padding-bottom: 2px;
  border-top: 1px solid var(--border-dim);
  border-bottom: none;
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}

.row .tag {
  justify-self: start;
}

/* The line before the action columns in the head, in the middle of the gap, as high as the titles
   (ui.css draws it for the web app's taller rows) */
.table-head :deep(.sep) {
  margin: 0 0 0 -4px;
  padding: 0 0 0 4px;
}

/* The kind as a small icon-only badge, hardly wider than its icon (no tooltip: the filter chips name the icons) */
.tag.kind {
  height: 16px;
  padding: 0 1px;
}

/* Every text cell clips at its end (the full text shows after a moment on hover) */
.cell {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.row .row-name {
  color: var(--text);
}

/* A component's stats after its name (the register dialog) */
.detail {
  color: var(--text-2);
}

.num {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
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
