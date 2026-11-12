<script lang="ts">
import { ref } from "vue";
// The picked scope survives switching tabs
const lastScope = ref("personal");
</script>

<script setup lang="ts">
// Stock: personal, one org's or all of them, grouped by material (alphabetical), best quality first
// within. Changes go through BatchDialog (confirmed); adding through StockAddForm (an org scope
// starts with that org's share switched on; the form stays open for the next batch). `components`:
// the ship components instead of the materials (ComponentsView; no quality, filters by type, size, grade).
import { computed, onMounted, onUnmounted, watch } from "vue";
import type { PriceSummary, StockBatch, StockListResponse, TradePricesResponse } from "../../../src/webapp/api-types";
import { valueMicros } from "../../../src/stock/amount";
import ChipButton from "../components/ChipButton.vue";
import TradeDialog from "../components/TradeDialog.vue";
import Dropdown from "../components/Dropdown.vue";
import InfoTip from "../components/InfoTip.vue";
import { typeIcon } from "../../../adminapp/src/typeIcons";
import { materials } from "../catalog";
import RangeSlider from "../components/RangeSlider.vue";
import ColumnHead from "../../../adminapp/src/components/ColumnHead.vue";
import Icon from "../../../adminapp/src/components/Icon.vue";
import { sortRows, THUMB_COLUMN, useTableColumns, type ColumnSpec, type SortState } from "../../../adminapp/src/tableColumns";
import { api } from "../api";
import { orgsOn, uexOn } from "../capabilities";
import BatchDialog, { type BatchAction } from "../components/BatchDialog.vue";
import ColumnsButton from "../components/ColumnsButton.vue";
import Thumb from "../components/Thumb.vue";
import ViewToggle from "../components/ViewToggle.vue";
import { materialThumb, thumbColumnFlag } from "../thumbs";
import ScopeBar, { scopeName } from "../components/ScopeBar.vue";
import StockAddForm from "../components/StockAddForm.vue";
import { compareBatches, ownerText, Q_TIER_MAX, qMark, qTier, qty, sharedText, statsText, tierMark, tierQualities, uec } from "../format";
import { columnsTexts, lang, t, viewTexts } from "../i18n";
import { ensureMembers, memberLabel, members, orgOf } from "../orgs";
import { takeQuery } from "../deepLink";
import { coalesced, onServerMessage } from "../realtime";
import { me } from "../session";
import { toastError } from "../toasts";

const props = defineProps<{ components?: boolean }>();

const scope = lastScope;
// A deep link picks the scope: personal, all or one of your orgs
const linked = takeQuery("scope");
if (linked && (linked === "personal" || linked === "all" || orgOf(linked))) scope.value = linked;
const data = ref<StockListResponse | null>(null);
const holder = ref("");
const materialText = ref("");
const locationFilter = ref("");
// Quality filter in tiers (qTier)
const qualityLow = ref(0);
const qualityHigh = ref(Q_TIER_MAX);
// Components: type label, size and grade letter ("" = all)
const typeFilter = ref("");
const sizeFilter = ref("");
const gradeFilter = ref("");
// Adding in a panel below the head: the form, then its own confirmation
const showAdd = ref(false);

function added() {
  void load();
}
const dialog = ref<{ batch: StockBatch; action: BatchAction } | null>(null);

const isOrg = (s: string) => s !== "personal" && s !== "all";
const org = computed(() => (isOrg(scope.value) ? orgOf(scope.value) : undefined));

// Left the org (or it went away): back to personal stock
watch(() => me.value?.orgs, () => {
  if (isOrg(scope.value) && !org.value) scope.value = "personal";
}, { immediate: true });

watch(scope, (s) => {
  holder.value = "";
  locationFilter.value = "";
  if (isOrg(s)) ensureMembers(s);
});

let seq = 0;
async function load() {
  const mine = ++seq;
  const query = !isOrg(scope.value)
    ? `scope=${scope.value}`
    : `scope=org&guildId=${encodeURIComponent(scope.value)}${holder.value ? `&holder=${encodeURIComponent(holder.value)}` : ""}`;
  try {
    // lang: material and location names (the server reads it, the contract does not list it yet)
    const r = await api<StockListResponse>(`/stock?${query}&lang=${lang.value}`);
    if (mine === seq) data.value = r;
  } catch (e) {
    if (mine === seq) toastError(e);
  }
}

watch([scope, holder], () => {
  data.value = null;
  void load();
}, { immediate: true });
watch(lang, load);

// UEX prices per material (GET /api/trade/prices): the Handel button and the UEC columns; per visit
const prices = ref<Record<string, PriceSummary>>({});
async function loadPrices() {
  // No UEX data offered (singleuser without a key): no prices, no UEC columns, the trade button greyed out
  if (!uexOn.value) return;
  try {
    prices.value = (await api<TradePricesResponse>("/trade/prices")).prices;
  } catch (e) {
    toastError(e);
  }
}
const trade = ref<{ uuid: string; name: string } | null>(null);

const reload = coalesced(() => void load());
let unsubscribe = () => {};
onMounted(() => {
  void loadPrices();
  if (isOrg(scope.value)) ensureMembers(scope.value);
  unsubscribe = onServerMessage((m) => {
    if (m.type === "resync") reload.schedule();
    // Your own list holds your shared batches too: it reloads on every stock change it may contain
    else if (m.type === "stock" && (!isOrg(scope.value) || (m.scope === "org" && m.guildId === scope.value))) reload.schedule();
  });
});
onUnmounted(() => {
  unsubscribe();
  reload.cancel();
});

// This view's batches: the materials or the ship components
const batches = computed(() => (data.value?.batches ?? []).filter((b) => b.component === !!props.components));

// A component's group shows its plain name; type, size and grade have their own columns
const nameOf = (b: StockBatch) => (b.component ? materials.value.get(b.subjectUuid)?.name ?? b.material : b.material);
const typeOf = (b: StockBatch) => materials.value.get(b.subjectUuid)?.typeLabel ?? t("filter.noType");
const sizeOf = (b: StockBatch) => materials.value.get(b.subjectUuid)?.size;
const gradeOf = (b: StockBatch) => materials.value.get(b.subjectUuid)?.gradeLetter;
const classOf = (b: StockBatch) => materials.value.get(b.subjectUuid)?.itemClass;
// The text search still finds a component by its type, size ("S3") and grade
const searchText = (b: StockBatch) => [
  nameOf(b),
  ...(b.component ? [typeOf(b), sizeOf(b) != null ? `S${sizeOf(b)}` : "", gradeOf(b) ?? ""] : []),
  b.location, statsText(b.subjectUuid, b.stats),
].join(" ");

const filtered = computed(() => {
  const words = materialText.value.toLowerCase().split(/\s+/).filter(Boolean);
  return batches.value.filter((b) =>
    (!locationFilter.value || b.locationUuid === locationFilter.value)
    && (props.components
      ? (!typeFilter.value || typeOf(b) === typeFilter.value) && (!sizeFilter.value || String(sizeOf(b)) === sizeFilter.value)
        && (!gradeFilter.value || gradeOf(b) === gradeFilter.value)
      : qTier(b.quality) >= qualityLow.value && qTier(b.quality) <= qualityHigh.value)
    && words.every((w) => searchText(b).toLowerCase().includes(w)));
});

// --- the table: one group per material (header with the total), its batches below ------------
// Every column but the name and the actions may be hidden (ColumnsButton right of the filters); the view
// 'thumbs' (ViewToggle) puts the thumbnail column first
const thumbCol = thumbColumnFlag();
// The org scopes keep columns of their own (`orgView`): holder instead of state, UEC hidden until switched on
const columnsFor = (orgView: boolean) => computed<ColumnSpec[]>(() => [
  ...(thumbCol.on.value ? [THUMB_COLUMN] : []),
  { key: "material", label: props.components ? t("stock.col.component") : t("stock.col.material"), width: 200 },
  ...(props.components
    ? [
        { key: "type", label: t("stock.col.type"), width: 160, hideable: true },
        { key: "size", label: t("stock.col.size"), width: 64, hideable: true },
        { key: "grade", label: t("stock.col.grade"), width: 72, hideable: true },
        { key: "class", label: t("stock.col.class"), width: 120, hideable: true, hiddenByDefault: true },
      ]
    : [{ key: "quality", label: t("stock.col.quality"), width: 130, hideable: true }]),
  { key: "amount", label: props.components ? t("stock.col.count") : t("stock.col.amount"), width: 120, hideable: true },
  ...(props.components ? [{ key: "stats", label: t("stock.col.stats"), width: 260, hideable: true }] : []),
  // What the amount is worth at UEX's prices (best sell shown, the others on demand); items have no averages
  ...(uexOn.value ? [
    { key: "uecSell", label: t("trade.col.sell"), width: 120, hideable: true, hiddenByDefault: orgView },
    { key: "uecBuy", label: t("trade.col.buy"), width: 120, hideable: true, hiddenByDefault: true },
  ] : []),
  ...(props.components || !uexOn.value ? [] : [
    { key: "uecSellAvg", label: t("trade.col.sellAvg"), width: 120, hideable: true, hiddenByDefault: true },
    { key: "uecBuyAvg", label: t("trade.col.buyAvg"), width: 120, hideable: true, hiddenByDefault: true },
  ]),
  { key: "location", label: t("stock.col.location"), width: 280, hideable: true },
  ...(orgView ? [{ key: "holder", label: t("stock.col.holder"), width: 180, hideable: true }] : []),
  ...(!orgView && scope.value === "all" ? [{ key: "owner", label: t("stock.col.owner"), width: 200, hideable: true }] : []),
  // Die Füllspalte (Rest der Breite, ohne Griff): ihre Breite ist ihr Minimum, daher das der anderen (MIN_WIDTH).
  // Nicht in der Org-Ansicht: Raffinerie-Aufträge werden nie geteilt, den Teilen-Tag braucht sie nicht, die Spalte
  // bliebe leer (dort ist "Halter" die Füllspalte)
  ...(orgView ? [] : [{ key: "state", label: t("stock.col.state"), width: 40, hideable: true }]),
  // Genau so breit wie die Buttons (je 26px, 6px Abstand) plus der Abstand hinter der Trennlinie (6px) und ein
  // Mini-Abstand (3px) vor der Handel-Spalte: Ressourcen fünf Buttons, Ausrüstung vier
  // (ohne Orgs fehlt der Teilen-Button: einer weniger)
  { key: "actions", label: "", width: (() => { const n = (props.components ? 4 : 5) - (orgsOn.value ? 0 : 1); return n * 26 + (n - 1) * 6; })() + 6 + 3, sortable: false, fixed: true, sep: true },
  // Der Handel-Button der Materialzeile (Preise gelten je Material); ohne UEX-Daten ausgegraut
  // Der Button füllt die Spalte (kein Polster); breit genug für "Handel" und "Trading"
  { key: "trade", label: "", width: 6 + 62, sortable: false, fixed: true, sep: true },
]);
const storageKey = props.components ? "qm.webapp.columns.components" : "qm.webapp.columns.stock";
const defaultSort: SortState = props.components ? { key: "amount", dir: "desc" } : { key: "quality", dir: "desc" };
const mineCols = useTableColumns(storageKey, columnsFor(false), defaultSort);
const orgCols = useTableColumns(`${storageKey}-org`, columnsFor(true), defaultSort);
// The table remounts on a scope switch (the list reloads), so it binds to the active one's `observe`
const cols = computed(() => (org.value ? orgCols : mineCols));
thumbCol.follow(computed(() => cols.value.view.value));
const thumbView = computed(() => cols.value.view.value === "thumbs");
const shown = computed(() => new Set(cols.value.columns.value.map((c) => c.key)));
const on = (key: string) => shown.value.has(key);
// Cells of a group row before the empty ones: (thumbnail,) name, (type, size, grade, class | quality,) total,
// (stats, empty,) UEC values; the trade button comes after them
const LEAD = new Set(["thumb", "material", "type", "size", "grade", "class", "quality", "amount", "stats", "uecSell", "uecBuy", "uecSellAvg", "uecBuyAvg"]);
const groupRest = computed(() => cols.value.columns.value.filter((c) => !LEAD.has(c.key) && c.key !== "trade").length);

// The UEC columns' prices: best sell (highest), best buy (lowest), UEX's averages
const UEC = {
  uecSell: (p: PriceSummary) => p.sell?.max,
  uecBuy: (p: PriceSummary) => p.buy?.min,
  uecSellAvg: (p: PriceSummary) => p.sell?.avg ?? undefined,
  uecBuyAvg: (p: PriceSummary) => p.buy?.avg ?? undefined,
};
type UecKey = keyof typeof UEC;
const isUec = (key: string): key is UecKey => Object.hasOwn(UEC, key);
const uecShown = computed(() => cols.value.columns.value.map((c) => c.key).filter(isUec));
/** An amount's worth at the column's price in micro aUEC (exact, BigInt); null without a price. */
function uecMicros(uuid: string, quantity: string, key: UecKey): bigint | null {
  const p = prices.value[uuid];
  const price = p && UEC[key](p);
  return price === undefined ? null : valueMicros(quantity, price);
}
const uecText = (micros: bigint | null) => (micros === null ? "—" : uec(Number(micros) / 1e6));
// The list's worth at the best sell prices (its stored batches, like the overview's total value); 0 without
// any price
const listWorth = computed(() => {
  let sum = 0n;
  for (const b of batches.value) {
    if (b.state !== "stored") continue;
    const m = uecMicros(b.subjectUuid, b.quantity, "uecSell");
    if (m !== null) sum += m;
  }
  return sum;
});

function valueOf(b: StockBatch, key: string): string | number {
  switch (key) {
    case "material": return nameOf(b);
    case "type": return typeOf(b);
    case "size": return sizeOf(b) ?? -1;
    case "grade": return gradeOf(b) ?? "";
    case "class": return classOf(b) ?? "";
    case "quality": return b.quality;
    case "amount": return Number(b.quantity);
    case "stats": return statsText(b.subjectUuid, b.stats);
    case "location": return b.location;
    case "holder": return b.holderName ?? "";
    case "owner": return ownerText(b);
    case "state": return b.state === "refining" ? t("stock.refining") : b.sharedIn.length ? sharedText(b) : "";
    default: {
      if (!isUec(key)) return "";
      const micros = uecMicros(b.subjectUuid, b.quantity, key);
      return micros === null ? -1 : Number(micros);
    }
  }
}

const groups = computed(() => {
  const by = new Map<string, StockBatch[]>();
  for (const b of filtered.value) by.set(b.subjectUuid, [...(by.get(b.subjectUuid) ?? []), b]);
  const { key, dir } = cols.value.sort.value;
  const sign = dir === "asc" ? 1 : -1;
  const byName = (a: { material: string }, b: { material: string }) => a.material.localeCompare(b.material, lang.value);
  const list = [...by.values()]
    .map((rows) => ({
      uuid: rows[0]!.subjectUuid, material: nameOf(rows[0]!), unit: rows[0]!.unit,
      total: data.value?.totals[rows[0]!.subjectUuid] ?? "0",
      rows: sortRows(rows, cols.value.sort.value, valueOf, compareBatches),
    }));
  // A component's type, size and grade belong to its group: the groups sort by them, then by name
  if (key === "type" || key === "size" || key === "grade") return sortRows(list, cols.value.sort.value, (g, k) => valueOf(g.rows[0]!, k), byName);
  // Groups follow the material, amount and UEC columns (by name, by total); otherwise alphabetical
  const worth = (g: { uuid: string; total: string }, k: UecKey) => Number(uecMicros(g.uuid, g.total, k) ?? -1n);
  return list.sort((a, b) => key === "material" ? sign * byName(a, b)
    : key === "amount" ? sign * (Number(a.total) - Number(b.total)) || byName(a, b)
    : isUec(key) ? sign * (worth(a, key) - worth(b, key)) || byName(a, b)
    : byName(a, b));
});

const locationOptions = computed(() => {
  const seen = new Map<string, string>();
  for (const b of batches.value) seen.set(b.locationUuid, b.location);
  return [
    { value: "", label: t("stock.allLocations") },
    ...[...seen].map(([value, label]) => ({ value, label })).sort((a, b) => a.label.localeCompare(b.label, lang.value)),
  ];
});

// Components: what the listed batches offer
const typeOptions = computed(() => [
  { value: "", label: t("filter.allTypes") },
  ...[...new Set(batches.value.map(typeOf))].sort((a, b) => a.localeCompare(b, lang.value)).map((v) => ({ value: v, label: v })),
]);
const sizeOptions = computed(() => [
  { value: "", label: t("filter.allSizes") },
  ...[...new Set(batches.value.map(sizeOf).filter((s): s is number => s != null))].sort((a, b) => a - b)
    .map((s) => ({ value: String(s), label: `S${s}` })),
]);
const gradeOptions = computed(() => [
  { value: "", label: t("filter.allGrades") },
  ...[...new Set(batches.value.map(gradeOf).filter((g): g is string => !!g))].sort().map((g) => ({ value: g, label: g })),
]);
// A choice the list no longer offers is dropped
watch(typeOptions, (o) => { if (!o.some((x) => x.value === typeFilter.value)) typeFilter.value = ""; });
watch(sizeOptions, (o) => { if (!o.some((x) => x.value === sizeFilter.value)) sizeFilter.value = ""; });
watch(gradeOptions, (o) => { if (!o.some((x) => x.value === gradeFilter.value)) gradeFilter.value = ""; });

const holderOptions = computed(() => [
  { value: "", label: t("stock.allHolders") },
  ...(org.value ? members[org.value.guildId] ?? [] : []).map((m) => ({ value: m.userId, label: memberLabel(m) })),
]);

const materialIcon = (uuid: string) => {
  const m = materials.value.get(uuid);
  return m?.kind === "item" ? typeIcon(m.type) : "resource";
};

// Yours only (the server says so: canChange)
const canChange = (b: StockBatch) => b.canChange;
// Whether any of your orgs takes shared stock right now
const shareable = computed(() => !!me.value?.orgs.length);

function open(batch: StockBatch, action: BatchAction) {
  dialog.value = { batch, action };
}
</script>

<template>
  <div class="page">
    <ScopeBar v-model="scope" all />

    <section class="panel unclipped">
      <div class="head">
        <Icon :name="components ? 'gear' : 'type-crate'" :size="16" />
        <span class="head-title">{{ components ? t("nav.components") : t("nav.stock") }} <span v-if="orgsOn" class="dim">· {{ scopeName(scope) }}</span><span v-if="uexOn" class="head-worth">({{ uecText(listWorth) }} aUEC)</span></span>
        <!-- Offen: als Umriss-Button "Schließen", damit nur der Hinzufügen-Button im Formular gefüllt ist -->
        <button type="button" class="btn small" :class="showAdd ? 'outline' : 'primary'" @click="showAdd = !showAdd">
          <Icon :name="showAdd ? 'close' : 'plus'" :size="14" />
          <span class="swap"><span :class="{ hidden: !showAdd }">{{ t("common.close") }}</span><span :class="{ hidden: showAdd }">{{ t("stock.add") }}</span></span>
        </button>
      </div>
      <div v-if="showAdd" class="add-area">
        <div class="head">
          <Icon name="plus" :size="16" />
          <span class="head-title">{{ t(components ? "components.addTitle" : "stock.addTitle") }}</span>
        </div>
        <StockAddForm :target="scope === 'all' ? undefined : scope === 'personal' ? null : scope" :components="components" @done="added" />
      </div>
      <div class="filters">
        <label class="search">
          <Icon name="search" :size="14" />
          <input v-model="materialText" type="text" :placeholder="t('filter.text')" />
          <button v-if="materialText" type="button" class="clear" @click="materialText = ''"><Icon name="close" :size="12" /></button>
        </label>
        <Dropdown v-model="locationFilter" variant="chip" :options="locationOptions" />
        <Dropdown v-if="org" v-model="holder" variant="chip" :options="holderOptions" />
        <template v-if="components">
          <Dropdown v-model="typeFilter" variant="chip" :options="typeOptions" />
          <Dropdown v-model="sizeFilter" variant="chip" :options="sizeOptions" />
          <Dropdown v-model="gradeFilter" variant="chip" :options="gradeOptions" />
        </template>
        <RangeSlider v-else v-model:low="qualityLow" v-model:high="qualityHigh" :min="0" :max="Q_TIER_MAX" :step="1" :format="tierMark" :detail="tierQualities" :label="t('field.quality')" />
        <ViewToggle :table="cols" :texts="viewTexts()" :size="22" />
        <ColumnsButton :table="cols" :texts="columnsTexts()" :size="22" />
        <span class="spacer" />
        <span class="head-count">{{ filtered.length }} / {{ batches.length }}</span>
      </div>

      <div v-if="!data" class="empty-line">{{ t("common.loading") }}</div>
      <div v-else-if="!batches.length" class="empty-line">{{ t("stock.empty") }}</div>
      <div v-else class="table" :class="{ 'view-thumbs': thumbView }" :ref="cols.observe" :style="{ '--cols': cols.template.value, '--cols-min': `${cols.minWidth.value}px` }">
        <ColumnHead :columns="cols.columns.value" :sort="cols.sort.value" @sort="cols.toggleSort" @resize="cols.startResize" @reset="cols.resetWidth" />
        <div v-if="!groups.length" class="empty-line">{{ t("stock.noMatch") }}</div>
        <template v-for="g in groups" :key="g.uuid">
          <!-- The material's row: its name, and its total under the amounts -->
          <div class="row data-row group-row">
            <span v-if="thumbView" class="thumb-cell">
              <InfoTip kind="material" :uuid="g.uuid"><Thumb v-bind="materialThumb(g.uuid)" size="m" :px="48" :icon="materialIcon(g.uuid)" :icon-size="24" /></InfoTip>
            </span>
            <span class="group-name">
              <!-- One info card for the thumbnail and the name: no gap in between that closes it -->
              <InfoTip kind="material" :uuid="g.uuid"><span class="name-tip"><Thumb v-if="!thumbView" v-bind="materialThumb(g.uuid)" size="s" :px="20" :icon="materialIcon(g.uuid)" :icon-size="15" />{{ g.material }}</span></InfoTip>
            </span>
            <template v-if="components">
              <span v-if="on('type')" class="cell">{{ typeOf(g.rows[0]!) }}</span>
              <span v-if="on('size')" class="num">{{ sizeOf(g.rows[0]!) ?? "—" }}</span>
              <span v-if="on('grade')">{{ gradeOf(g.rows[0]!) ?? "—" }}</span>
              <span v-if="on('class')" class="cell">{{ classOf(g.rows[0]!) ?? "—" }}</span>
            </template>
            <span v-else-if="on('quality')" />
            <span v-if="on('amount')" class="num group-total">{{ qty(g.total, g.unit) }}</span>
            <span v-if="components && on('stats')" />
            <span v-for="k in uecShown" :key="k" class="num uec total">{{ uecText(uecMicros(g.uuid, g.total, k)) }}</span>
            <span v-for="c in groupRest" :key="c" :class="{ sep: c === groupRest }" />
            <!-- Without UEX data (singleuser without a key) the button stays, greyed out; the cell's tooltip says why -->
            <span class="sep trade" :title="uexOn ? undefined : t('trade.noUex')"><ChipButton :label="t('trade.button')" :disabled="!uexOn || !prices[g.uuid]" @click="trade = { uuid: g.uuid, name: g.material }" /></span>
          </div>
          <div v-for="b in g.rows" :key="b.id" class="row data-row batch-row">
            <span v-if="thumbView" />
            <span />
            <template v-if="components"><span v-if="on('type')" /><span v-if="on('size')" /><span v-if="on('grade')" /><span v-if="on('class')" /></template>
            <span v-else-if="on('quality')" class="num"><span class="qcell"><span>{{ qMark(b.quality) }}</span><span>{{ b.quality }}</span></span></span>
            <!-- Ausrüstung: jeder Eintrag ist ein Stück ("1 Stk.") -->
            <span v-if="on('amount')" class="num">{{ qty(b.quantity, b.unit) }}</span>
            <!-- Ohne Verbesserung: "Standard", dezent -->
            <span v-if="components && on('stats')" class="cell" :class="{ dim: !statsText(b.subjectUuid, b.stats) }" :title="statsText(b.subjectUuid, b.stats)">{{ statsText(b.subjectUuid, b.stats) || t("stock.standard") }}</span>
            <span v-for="k in uecShown" :key="k" class="num uec">{{ uecText(uecMicros(b.subjectUuid, b.quantity, k)) }}</span>
            <span v-if="on('location')" class="cell">{{ b.location }}</span>
            <span v-if="org && on('holder')" class="cell user-cell">{{ b.holderName }}</span>
            <span v-if="scope === 'all' && on('owner')" class="cell user-cell">{{ ownerText(b) }}</span>
            <span v-if="on('state')">
              <span v-if="b.state === 'refining'" class="tag warn">{{ t("stock.refining") }}</span>
              <!-- Where it is shared -->
              <span v-else-if="b.sharedIn.length" class="tag accent">{{ sharedText(b) }}</span>
            </span>
            <span class="sep actions">
              <!-- Fremde Einträge (Org-Ansicht, Alle): dieselben Buttons, ausgegraut -->
              <!-- Sharing needs an org to share in; taking back always works -->
              <button v-if="orgsOn" type="button" class="icon-btn" :title="t('field.sharing')"
                :disabled="!canChange(b) || b.state !== 'stored' || (!b.sharedIn.length && !shareable)" @click="open(b, 'share')"><Icon name="users" :size="15" /></button>
              <!-- In der Raffinerie: nichts entnehmen; korrigiert wird im Raffinerie-Tab -->
              <button type="button" class="icon-btn" :title="t('stock.remove')" :disabled="!canChange(b) || b.state !== 'stored'" @click="open(b, 'remove')"><Icon name="arrow-up" :size="15" /></button>
              <button type="button" class="icon-btn" :title="t('stock.move')" :disabled="!canChange(b) || b.state !== 'stored'" @click="open(b, 'move')"><Icon name="move" :size="15" /></button>
              <!-- A part goes back into its main batch; only unshared batches split. Ausrüstung (ein Stück
                   je Eintrag): weder Aufteilen noch Zusammenführen -->
              <template v-if="!components">
                <button v-if="b.part" type="button" class="icon-btn" :title="t('stock.merge')" :disabled="!canChange(b)" @click="open(b, 'merge')"><Icon name="merge" :size="15" /></button>
                <button v-else type="button" class="icon-btn" :title="t('stock.split')"
                  :disabled="!canChange(b) || b.state !== 'stored' || b.sharedIn.length > 0" @click="open(b, 'split')"><Icon name="split" :size="15" /></button>
              </template>
              <!-- Ausrüstung: nur die Werte korrigieren; bei Teilen ohne Werte deaktiviert (kein Layout-Sprung) -->
              <button v-if="!components" type="button" class="icon-btn" :title="t('stock.adjust')" :disabled="!canChange(b) || b.state !== 'stored'" @click="open(b, 'adjust')"><Icon name="edit" :size="15" /></button>
              <button v-else type="button" class="icon-btn" :title="t('stock.adjustStats')" :disabled="!canChange(b) || !materials.get(b.subjectUuid)?.stats.length" @click="open(b, 'adjust')"><Icon name="edit" :size="15" /></button>
            </span>
            <span class="sep" />
          </div>
        </template>
      </div>
    </section>

    <BatchDialog v-if="dialog" :key="dialog.batch.id" :batch="dialog.batch" :action="dialog.action" @close="dialog = null" @done="load" />
    <TradeDialog v-if="trade && uexOn":key="trade.uuid" :uuid="trade.uuid" :name="trade.name" @close="trade = null" />
  </div>
</template>

<style scoped>
/* A material: its name and total over the whole row */
.group-row {
  background: var(--bg-surface-2);
}

/* A material's own row: name and total stand out */
.group-name {
  display: flex;
  align-items: center;
  gap: 8px;
}

.group-name,
.group-total {
  font-size: 14px;
  font-weight: 600;
}

/* The larger list view: a little larger too */
.view-thumbs .group-name,
.view-thumbs .group-total {
  font-size: 15px;
}

/* UEX values: secondary figures, quieter than the amounts, the material's total a little brighter; the face
   as in the trading tables' price column (the unit stands in the column's title) */
.uec {
  color: var(--text-3);
}

.uec.total {
  color: var(--text-2);
}

/* Der Wert hinter dem Titel: abgesetzt und leiser als der Titel */
.head-worth {
  margin-left: 10px;
  font-family: var(--font-mono);
  font-size: 12px;
  font-weight: 400;
  color: var(--text-3);
}

/* Rows look like the blueprint table's (same .data-row type), without the click cursor */
.data-row {
  cursor: default;
  user-select: text;
}

.cell {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.actions {
  justify-content: flex-end;
  gap: 6px;
}

/* A hair of room before the Handel column's line (ui.css's .sep sets no right padding) */
.sep.actions {
  padding-right: 3px;
}

/* The button fills the column */
.trade :deep(.chip-btn) {
  flex: 1;
  justify-content: center;
}

</style>
