<script setup lang="ts">
// The inventory scan's proposals (inventorySync.ts; scan and location are in the scan row,
// ScanBar.vue), one panel per part: stock (the user hovers every stack in the freight manager's
// warehouse) and comps (every component in the character inventory's storage pane). "Register all" in
// the head, after the count the part's kind filter (what the scan detects; off: its screen is not read), then
// the proposals of every location as a compact table with resizable columns, one row per stack (kind,
// name, quality, amount, location) or component (name, type, size, grade, stats, location), each with
// Register / Discard; what the stored stock holds already stays dimmed without them (also in the overlay;
// counts and "Register all" only the rest). Registering (one or all, each at
// its own location) asks first, with a switch per org to share right away. The overlay shows the
// current location's only. The sightings behind the proposals, also the incomplete ones, are in the
// debug window (settings). Without proposals: one line, how to get them as a quiet hint below.
import { computed, ref, watch, watchEffect } from "vue";
import ColumnHead from "../../../adminapp/src/components/ColumnHead.vue";
import Icon from "../../../adminapp/src/components/Icon.vue";
import Tooltip from "../../../adminapp/src/components/Tooltip.vue";
import { useTableColumns, type ColumnSpec } from "../../../adminapp/src/tableColumns";
import { statValueText } from "../../../src/stock/component-stats";
import ConfirmDialog, { type ConfirmButton } from "../../../webapp/src/components/ConfirmDialog.vue";
import type { ComponentProposal } from "../components";
import ColumnsButton from "../../../webapp/src/components/ColumnsButton.vue";
import { columnsTexts, langRef, t } from "../i18n";
import type { Proposal } from "../inventory";
import {
  accept, acceptComponent, componentProposals, componentSightings, dismiss, KIND_CLASS, KIND_ICON, kinds, locationUuid, proposals,
  shareGuildIds, sightings, toggleKind, type Kind, type Listed,
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
  // A component's stats ("Coolant Rating +12.5 %"), or "Standard" without any gain
  detail: string | null;
  // The detail is "Standard": shown dimmed
  standard: boolean;
  locationUuid: string;
  location: string;
  quality: string;
  amount: string;
  // The stored stock holds it already (dimmed, nothing to register)
  inStock: boolean;
  stack: Listed<Proposal> | null;
  component: Listed<ComponentProposal> | null;
}

const locationName = (uuid: string) => syncCatalog.value?.locations.find((l) => l.uuid === uuid)?.short ?? "?";

const amount = (value: string, unit: "SCU" | "pcs") => (unit === "SCU" ? `${value} SCU` : t("inventory.pieces", { n: value }));
// Every stat the tooltip showed, in the catalog's order, as its gain: "Coolant Rating +12.5 % · Integrity ±0.0 %";
// without any gain, or when the tooltip showed none (weapons, event items), "Standard" (shown dimmed, see
// `standard`)
function statsOf(p: ComponentProposal): { detail: string; standard: boolean } {
  const defs = syncCatalog.value?.components.components.find((c) => c.uuid === p.componentUuid)?.stats ?? [];
  const shown = defs.filter((s) => p.readStats.includes(s.uuid) || s.uuid in p.stats);
  // No gain at all: the component as the game hands it out
  if (!shown.length || Object.values(p.stats).every((v) => Number(v) === 0)) return { detail: t("components.standard"), standard: true };
  return { detail: shown.map((s) => `${s.name} ${statValueText(s.kind, p.stats[s.uuid] ?? "0")}`).join(" · "), standard: false };
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
    kind: p.unit === "SCU" ? "mats" : "items", id: p.id, name: materialName(p.materialUuid), type: "", size: "", grade: "", detail: null, standard: false,
    locationUuid: p.locationUuid, location: locationName(p.locationUuid), quality: String(p.quality), amount: amount(p.amount, p.unit), inStock: p.inStock, stack: p, component: null,
  }))
  // No quality (the register dialog's column stays empty)
  : componentProposals.value.map((p): Row => ({
    kind: "comps", id: p.id, name: catalogMaterials.value.get(p.componentUuid)?.name ?? p.label, ...described(p.componentUuid), ...statsOf(p),
    locationUuid: p.locationUuid, location: locationName(p.locationUuid), quality: "", amount: t("inventory.pieces", { n: 1 }), inStock: p.inStock, stack: null, component: p,
  })));
// What is still to register: the counts and "Register all"
const openRows = computed(() => rows.value.filter((r) => !r.inStock));

// The table's columns (widths and the hidden ones kept per table; no sorting: the newest come first);
// the last shown one takes the room left. Stacks: kind, quality and amount; components: catalog data and
// stats. Every one but the name and the actions may be hidden (ColumnsButton in the actions' head)
const columns = computed<ColumnSpec[]>(() => [
  ...(stock ? [{ key: "kind", label: "", title: t("col.kind"), width: 20, fixed: true, sortable: false, hideable: true }] : []),
  { key: "name", label: t("debug.col.name"), width: 120, sortable: false },
  ...(stock
    ? [
      { key: "quality", label: t("col.quality"), width: 40, sortable: false, hideable: true },
      { key: "amount", label: t("col.amount"), width: 60, sortable: false, hideable: true },
    ]
    : [
      { key: "type", label: t("col.type"), width: 70, sortable: false, hideable: true },
      { key: "size", label: t("col.size"), width: 40, sortable: false, hideable: true },
      { key: "grade", label: t("col.grade"), width: 40, sortable: false, hideable: true },
      { key: "stats", label: t("col.stats"), width: 120, sortable: false, hideable: true },
    ]),
  { key: "location", label: t("col.location"), width: 80, sortable: false, hideable: true },
  // The action buttons: as wide as an icon button, always; a line before them in the head
  { key: "register", label: "", width: 26, fixed: true, sortable: false, sep: true },
  { key: "drop", label: "", width: 26, fixed: true, sortable: false },
]);
// The compact rows' column gap (.table.compact in App.vue)
const ROW_GAP = 8;
const cols = useTableColumns(`qm.companion.${props.part}.columns`, columns, { key: "name", dir: "asc" }, ROW_GAP);
const shown = computed(() => new Set(cols.columns.value.map((c) => c.key)));
const what = (r: Row) => [r.name, r.detail ?? r.quality, r.amount].join(" · ");
const tagClass: Record<Kind, string> = KIND_CLASS;
const kindIcon = KIND_ICON;
// The scan overlay shows the current location's rows, the most recently seen first (what the stock holds dimmed)
watchEffect(() => {
  const seen = new Map((stock ? sightings.value : componentSightings.value).map((s) => [s.key, s.atMs]));
  overlayRows[props.part] = rows.value
    .filter((r) => r.locationUuid === locationUuid.value)
    .sort((a, b) => (seen.get(b.id) ?? 0) - (seen.get(a.id) ?? 0))
    // A component: its name and stats; a stack: its name, quality and amount
    .map((r) => ({ tag: "", icon: kindIcon[r.kind], cls: tagClass[r.kind], name: r.name, detail: r.detail, cols: r.component ? [] : [r.quality, r.amount], dim: r.inStock }));
  tabCounts[props.part] = openRows.value.length;
});

// The register dialog: one row, or all of them; with rows at several locations a switch per location
// (all on when it opens) picks the ones to register
const registering = ref<Row[] | null>(null);
const skipped = ref(new Set<string>());
watch(registering, () => (skipped.value = new Set()));
const places = computed(() => {
  const seen = new Map<string, string>();
  for (const r of registering.value ?? []) seen.set(r.locationUuid, r.location);
  return [...seen].map(([uuid, name]) => ({ uuid, name }));
});
function togglePlace(uuid: string) {
  const next = new Set(skipped.value);
  if (next.has(uuid)) next.delete(uuid);
  else next.add(uuid);
  skipped.value = next;
}
const toRegister = computed(() => (registering.value ?? []).filter((r) => !skipped.value.has(r.locationUuid)));
// The dialog's rows show the table's columns in its order (without the actions)
const DIALOG_WIDTHS: Record<string, string> = {
  kind: "16px", name: "minmax(0, 1fr)", quality: "40px", amount: "72px", type: "minmax(0, 70px)", size: "30px", grade: "24px",
  stats: "minmax(0, 1fr)", location: "minmax(0, 110px)",
};
const dialogKeys = computed(() => cols.columns.value.map((c) => c.key).filter((k) => k in DIALOG_WIDTHS));
const dialogCols = computed(() => dialogKeys.value.map((k) => DIALOG_WIDTHS[k]).join(" "));
const busy = ref(false);
const registerButtons = computed<ConfirmButton[]>(() => [
  { label: t("common.cancel"), kind: "outline", value: "cancel" },
  { label: t("inventory.register"), kind: "primary", value: "add", icon: "check", disabled: busy.value || !connected.value || !toRegister.value.length },
]);
// The dialog's title names the location when all rows share one
const registeringTitle = computed(() => {
  const list = toRegister.value;
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
  const list = toRegister.value;
  if (value !== "add" || !list.length) return void (registering.value = null);
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
      <span class="head-title no-grow">{{ t(`${part}.title`) }} <span class="head-count">{{ openRows.length }}</span></span>
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
        <button type="button" class="btn small primary" :disabled="!connected || !openRows.length || busy" @click="registering = [...openRows]">
          <Icon name="check" :size="14" /> {{ t("inventory.addAll") }}
        </button>
      </Tooltip>
    </div>
    <div v-if="!rows.length" class="empty-line">
      {{ t(`${part}.empty`) }}
      <div class="empty-hint">{{ t(`${part}.emptyHint`) }}</div>
    </div>
    <!-- The web app's table, compact (App.vue): it scrolls, its column titles stick to its top; the columns
         always fit its width (measured on it), the actions stay in view -->
    <div v-else class="table compact" :ref="cols.observe" :style="{ '--cols': cols.template.value, '--cols-min': `${cols.minWidth.value}px` }">
      <ColumnHead :columns="cols.columns.value" :sort="cols.sort.value" @resize="cols.startResize" @reset="cols.resetWidth">
        <template #col-drop><ColumnsButton :table="cols" :texts="columnsTexts()" /></template>
      </ColumnHead>
      <div v-for="r in rows" :key="r.id" class="row data-row" :class="{ done: r.inStock }">
        <span v-if="shown.has('kind')" class="tag kind" :class="tagClass[r.kind]"><Icon :name="kindIcon[r.kind]" :size="11" /></span>
        <span class="cell row-name">{{ r.name }}</span>
        <span v-if="shown.has('quality')" class="num">{{ r.quality }}</span>
        <span v-if="shown.has('amount')" class="num">{{ r.amount }}</span>
        <span v-if="shown.has('type')" class="cell">{{ r.type }}</span>
        <span v-if="shown.has('size')" class="cell">{{ r.size }}</span>
        <span v-if="shown.has('grade')" class="cell">{{ r.grade }}</span>
        <span v-if="shown.has('stats')" class="cell" :class="{ dim: r.standard }">{{ r.detail }}</span>
        <span v-if="shown.has('location')" class="cell loc">{{ r.location }}</span>
        <!-- In stock already: nothing to register or discard, the columns stay -->
        <template v-if="r.inStock"><span /><span /></template>
        <template v-else>
          <Tooltip :text="t('inventory.register')">
            <button type="button" class="icon-btn" :disabled="!connected || busy" @click="registering = [r]"><Icon name="check" :size="14" /></button>
          </Tooltip>
          <Tooltip :text="t('inventory.drop')">
            <button type="button" class="icon-btn" @click="dismiss(r.id)"><Icon name="close" :size="14" /></button>
          </Tooltip>
        </template>
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
        <!-- Rows at several locations: which ones to register -->
        <div v-if="places.length > 1" class="share places">
          <div class="share-title">{{ t("inventory.locations") }}</div>
          <label v-for="p in places" :key="p.uuid" class="share-row">
            <input type="checkbox" :checked="!skipped.has(p.uuid)" @change="togglePlace(p.uuid)" />
            <span class="loc">{{ p.name }}</span>
          </label>
        </div>
        <!-- The table's columns in its order; a long list scrolls -->
        <div class="confirm-list" :style="{ '--dialog-cols': dialogCols }">
          <div v-for="r in toRegister" :key="r.id" class="confirm-row">
            <template v-for="k in dialogKeys" :key="k">
              <span v-if="k === 'kind'" class="tag kind" :class="tagClass[r.kind]"><Icon :name="kindIcon[r.kind]" :size="11" /></span>
              <span v-else-if="k === 'quality' || k === 'amount'" class="num">{{ r[k] }}</span>
              <span v-else class="cell" :class="{ 'row-name': k === 'name', loc: k === 'location', dim: k === 'stats' && r.standard }">{{ k === "stats" ? r.detail : r[k as "name" | "type" | "size" | "grade" | "location"] }}</span>
            </template>
          </div>
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

/* The table below the head and filter: a line between them */
.table {
  border-top: 1px solid var(--border-dim);
}

/* The location in the mono face, like the overlay's location line */
.loc {
  font-family: var(--font-mono);
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

/* One row per stack or component (the table's look: App.vue .table.compact) */
.data-row {
  color: var(--text-2);
}

.row .tag {
  justify-self: start;
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

/* In stock already: dimmed like the blueprints' registered rows */
.row.done,
.row.done .row-name {
  color: var(--text-3);
}

.num {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  text-align: right;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

/* The register dialog: the location switches (several locations), the rows, then the share switches */
.confirm {
  display: flex;
  flex-direction: column;
  gap: 6px;
  font-size: 12px;
  color: var(--text-2);
}

/* A long list scrolls inside the dialog */
.confirm-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
  max-height: 40vh;
  overflow-y: auto;
}

.confirm-row {
  display: grid;
  grid-template-columns: var(--dialog-cols);
  align-items: center;
  gap: 8px;
}

.confirm-row .row-name {
  color: var(--text);
}

.share {
  margin-top: 8px;
  padding-top: 8px;
  border-top: 1px solid var(--border-dim);
  display: flex;
  flex-direction: column;
  gap: 4px;
}

/* The location switches above the rows: the line below them */
.share.places {
  margin: 0 0 8px;
  padding: 0 0 8px;
  border-top: none;
  border-bottom: 1px solid var(--border-dim);
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
