<script setup lang="ts">
// Blueprints as a table like the admin UI's: scope "personal" (yours: add, remove) or an org (every
// blueprint its active members registered, with who has it). Filters: text, category, type, size, and in
// an org the member.
import { computed, onMounted, onUnmounted, ref, shallowRef, watch } from "vue";
import type {
  BlueprintListResponse, BlueprintOwner, BlueprintRequest, CatalogBlueprint, OkResponse, OrgBlueprintsResponse,
} from "../../../src/webapp/api-types";
import DataTable from "../../../adminapp/src/components/DataTable.vue";
import Icon from "../../../adminapp/src/components/Icon.vue";
import type { ColumnSpec, useTableColumns } from "../../../adminapp/src/tableColumns";
import { useRouter } from "vue-router";
import { api } from "../api";
import { addToCrafting } from "../crafting";
import { blueprints, catalog } from "../catalog";
import ChipButton from "../components/ChipButton.vue";
import ColumnsButton from "../components/ColumnsButton.vue";
import ConfirmDialog, { type ConfirmButton } from "../components/ConfirmDialog.vue";
import Dropdown from "../components/Dropdown.vue";
import InfoTip from "../components/InfoTip.vue";
import TypeLabel from "../components/TypeLabel.vue";
import UnlocksDialog from "../components/UnlocksDialog.vue";
import Picker from "../components/Picker.vue";
import ScopeBar, { scopeName } from "../components/ScopeBar.vue";
import { columnsTexts, lang, t } from "../i18n";
import { memberLabel, orgOf } from "../orgs";
import { takeQuery } from "../deepLink";
import { coalesced, onServerMessage } from "../realtime";
import { me } from "../session";
import { toast, toastError } from "../toasts";

interface Row {
  uuid: string;
  bp: CatalogBlueprint | undefined;
  owners: BlueprintOwner[];
}

const router = useRouter();

// A click on a row checks the blueprint in the crafting view
function craft(row: Row) {
  addToCrafting(row.uuid);
  void router.push("/crafting");
}

// "personal" or a guildId
const scope = ref("personal");
// A deep link picks the scope: personal or one of your orgs
const linked = takeQuery("scope");
if (linked && orgOf(linked)) scope.value = linked;
const org = computed(() => (scope.value === "personal" ? undefined : orgOf(scope.value)));
// Back to personal when the org is gone (left, role lost)
watch(() => me.value?.orgs, () => {
  if (scope.value !== "personal" && !org.value) scope.value = "personal";
});

const mine = ref<string[] | null>(null);
const orgEntries = ref<OrgBlueprintsResponse["entries"] | null>(null);
const busy = ref(false);

async function loadMine() {
  try {
    mine.value = (await api<BlueprintListResponse>("/blueprints")).uuids;
  } catch (e) {
    toastError(e);
  }
}

async function loadOrg() {
  const guildId = org.value?.guildId;
  if (!guildId) return;
  try {
    const found = (await api<OrgBlueprintsResponse>(`/orgs/${guildId}/blueprints`)).entries;
    if (org.value?.guildId === guildId) orgEntries.value = found;
  } catch (e) {
    toastError(e);
  }
}

watch(scope, () => {
  orgEntries.value = null;
  member.value = "";
  void loadOrg();
});

// --- filters ---------------------------------------------------------------------------------
const search = ref("");
const type = ref("");
const category = ref("");
const size = ref("");
const member = ref("");

const allRows = computed<Row[]>(() => {
  if (!org.value) return (mine.value ?? []).map((uuid) => ({ uuid, bp: blueprints.value.get(uuid), owners: [] }));
  return (orgEntries.value ?? []).map((e) => ({ uuid: e.uuid, bp: blueprints.value.get(e.uuid), owners: e.owners }));
});

const byText = (a: string, b: string) => a.localeCompare(b, lang.value);
function options(values: (string | null | undefined)[], all: string, label = (v: string) => v) {
  const unique = [...new Set(values.filter((v): v is string => !!v))].sort(byText);
  return [{ value: "", label: all }, ...unique.map((v) => ({ value: v, label: label(v) }))];
}
// Filter chain like the admin UI's: category -> type -> size; each list only offers what the previous
// choice leaves. Blueprints without a type are a choice of their own, "(none)".
const categoryOf = (r: Row) => r.bp?.category ?? t("bp.other");
const typeOf = (r: Row) => r.bp?.typeLabel ?? t("filter.noType");
const inCategory = computed(() => allRows.value.filter((r) => !category.value || categoryOf(r) === category.value));
const inType = computed(() => inCategory.value.filter((r) => !type.value || typeOf(r) === type.value));
const categoryOptions = computed(() => options(allRows.value.map(categoryOf), t("filter.allCategories")));
const typeOptions = computed(() => options(inCategory.value.map(typeOf), t("filter.allTypes")));
const sizeOptions = computed(() => [
  { value: "", label: t("filter.allSizes") },
  ...[...new Set(inType.value.map((r) => r.bp?.size).filter((s): s is number => s !== null && s !== undefined))]
    .sort((a, b) => a - b).map((s) => ({ value: String(s), label: `S${s}` })),
]);
const memberOptions = computed(() => [
  { value: "", label: t("filter.allMembers") },
  ...[...new Map(allRows.value.flatMap((r) => r.owners).map((o) => [o.userId, o]))].map(([value, o]) => ({ value, label: memberLabel(o) }))
    .sort((a, b) => byText(a.label, b.label)),
]);
// A choice the list no longer offers is dropped
watch(categoryOptions, (o) => { if (!o.some((x) => x.value === category.value)) category.value = ""; });
watch(typeOptions, (o) => { if (!o.some((x) => x.value === type.value)) type.value = ""; });
watch(sizeOptions, (o) => { if (!o.some((x) => x.value === size.value)) size.value = ""; });

const rows = computed(() => {
  const words = search.value.toLowerCase().split(/\s+/).filter(Boolean);
  return inType.value.filter((r) => {
    if (size.value && String(r.bp?.size) !== size.value) return false;
    if (member.value && !r.owners.some((o) => o.userId === member.value)) return false;
    const hay = [r.bp?.label, r.bp?.category, ...r.owners.map(memberLabel)].join(" ").toLowerCase();
    return words.every((w) => hay.includes(w));
  });
});

// --- table -------------------------------------------------------------------------------------
const columns = computed<ColumnSpec[]>(() => [
  { key: "name", label: t("bp.col.name"), width: 300 },
  { key: "type", label: t("bp.col.type"), width: 160, hideable: true },
  { key: "category", label: t("bp.col.category"), width: 170, hideable: true },
  { key: "size", label: t("bp.col.size"), width: 64, hideable: true },
  { key: "grade", label: t("bp.col.grade"), width: 72, hideable: true },
  { key: "stats", label: t("bp.col.stats"), width: 280, hideable: true },
  org.value ? { key: "owners", label: t("bp.col.owners"), width: 240, hideable: true } : { key: "actions", label: "", width: 44, sortable: false, fixed: true, sep: true },
  // Last: the unlocks button (the column chooser sits right of the filters)
  { key: "unlock", label: "", width: lang.value === "de" ? 124 : 96, sortable: false, fixed: true, sep: true },
]);
// The blueprint whose unlocks dialog is open
const unlocksOf = ref<Row | null>(null);
// The table's column state, for the column chooser right of the filters
const table = shallowRef<{ table: ReturnType<typeof useTableColumns> } | null>(null);

function valueOf(r: Row, key: string): string | number {
  switch (key) {
    case "name": return r.bp?.name ?? t("bp.unknown");
    case "type": return r.bp?.typeLabel ?? "";
    case "category": return r.bp?.category ?? t("bp.other");
    case "size": return r.bp?.size ?? -1;
    case "grade": return r.bp?.gradeLetter ?? "";
    case "stats": return r.bp?.stats.join(", ") ?? "";
    case "owners": return r.owners.length;
    default: return "";
  }
}

// --- add (right away, the toast says what) / remove (confirmed first) ---------------------------
const adding = ref<string | null>(null);
const addOptions = computed(() => {
  const owned = new Set(mine.value ?? []);
  return (catalog.value?.blueprints ?? [])
    .filter((b) => !b.isDefault && !b.retired && !owned.has(b.uuid))
    .map((b) => ({ value: b.uuid, label: b.label, hint: b.category ?? undefined }))
    .sort((a, b) => byText(a.label, b.label));
});
const label = (uuid: string) => blueprints.value.get(uuid)?.label ?? t("bp.unknown");

// The blueprint waiting for the remove confirmation
const pending = ref<string | null>(null);
// The add panel below the head: picking a blueprint adds it, an added one closes the panel
const addOpen = ref(false);
// Clear: a new picker drops the typed search
const pickerKey = ref(0);
watch(adding, (uuid) => {
  if (!uuid) return;
  adding.value = null;
  void send("add", uuid);
});
const confirmButtons = computed<ConfirmButton[]>(() => [
  { label: t("common.cancel"), kind: "outline", value: "cancel" },
  { label: t("common.confirm"), kind: "danger", value: "confirm", disabled: busy.value },
]);

async function send(action: "add" | "remove", uuid: string) {
  if (busy.value) return;
  busy.value = true;
  try {
    const body: BlueprintRequest = { uuid };
    await api<OkResponse>(`/blueprints/${action}`, { method: "POST", body });
    toast(t(action === "add" ? "bp.added" : "bp.removed", { name: label(uuid) }));
    if (action === "add") addOpen.value = false;
    void loadMine();
  } catch (e) {
    toastError(e);
  } finally {
    busy.value = false;
  }
}

async function choose(value: string) {
  const uuid = pending.value;
  if (value === "confirm" && uuid) await send("remove", uuid);
  pending.value = null;
}

const reloadMine = coalesced(() => void loadMine());
const reloadOrg = coalesced(() => void loadOrg());
let unsubscribe = () => {};
onMounted(() => {
  void loadMine();
  unsubscribe = onServerMessage((m) => {
    if (m.type === "resync") {
      reloadMine.schedule();
      reloadOrg.schedule();
    } else if (m.type === "blueprints") {
      if (m.userId === me.value?.userId) reloadMine.schedule();
      // Anyone in the org may have added or removed one
      reloadOrg.schedule();
    } else if ((m.type === "members" && m.guildId === org.value?.guildId) || m.type === "profile") reloadOrg.schedule();
  });
});
onUnmounted(() => {
  unsubscribe();
  reloadMine.cancel();
  reloadOrg.cancel();
});
</script>

<template>
  <div class="page">
    <ScopeBar v-model="scope" />

    <section class="panel unclipped">
      <div class="head">
        <Icon name="blueprint" :size="16" />
        <span class="head-title">{{ t("nav.blueprints") }} <span class="dim">· {{ scopeName(scope) }}</span></span>
        <button v-if="!org" type="button" class="btn small" :class="addOpen ? 'outline' : 'primary'" :disabled="!catalog" @click="addOpen = !addOpen">
          <Icon :name="addOpen ? 'close' : 'plus'" :size="14" /> {{ addOpen ? t("common.close") : t("bp.add") }}
        </button>
      </div>
      <div v-if="addOpen && !org" class="add-area">
        <div class="head"><Icon name="plus" :size="16" /><span class="head-title">{{ t("bp.addTitle") }}</span></div>
        <div class="form single">
          <Picker :key="pickerKey" v-model="adding" :options="addOptions" :placeholder="t('pick.blueprint')" />
          <div class="form-actions">
            <button type="button" class="btn outline" @click="pickerKey++"><Icon name="close" :size="14" /> {{ t("common.clear") }}</button>
          </div>
        </div>
      </div>
      <div class="filters">
        <label class="search">
          <Icon name="search" :size="14" />
          <input v-model="search" type="text" :placeholder="t('filter.text')" />
          <button v-if="search" type="button" class="clear" :title="t('pick.clear')" @click="search = ''">
            <Icon name="close" :size="12" />
          </button>
        </label>
        <Dropdown v-model="category" :options="categoryOptions" variant="chip" />
        <Dropdown v-model="type" :options="typeOptions" variant="chip" />
        <Dropdown v-model="size" :options="sizeOptions" variant="chip" />
        <Dropdown v-if="org" v-model="member" :options="memberOptions" variant="chip" />
        <ColumnsButton v-if="table?.table" :table="table.table" :texts="columnsTexts()" :size="22" />
        <span class="spacer" />
        <span class="head-count">{{ rows.length }} / {{ allRows.length }}</span>
      </div>
      <div v-if="org ? !orgEntries : !mine" class="empty-line">{{ t("common.loading") }}</div>
      <div v-else-if="!allRows.length" class="empty-line">{{ t(org ? "bp.orgNone" : "bp.none") }}</div>
      <!-- Keyed by its storage key: org and personal list keep their own columns (a scope switch rebuilds it) -->
      <DataTable
        v-else
        ref="table"
        :key="org ? 'bp-org' : 'bp-mine'"
        :storage-key="org ? 'qm.webapp.columns.bp-org' : 'qm.webapp.columns.bp-mine'"
        :columns="columns"
        :rows="rows"
        :default-sort="{ key: 'name', dir: 'asc' }"
        :row-key="(r: Row) => r.uuid"
        :value-of="valueOf"
        :numeric="['size']"
        :empty-text="t('common.noMatch')"
        @select="craft"
      >
        <template #cell-name="{ row }">
          <InfoTip kind="blueprint" :uuid="row.uuid"><span class="bp-name">{{ row.bp?.name ?? t("bp.unknown") }}</span></InfoTip>
          <span v-if="row.bp?.retired" class="tag err">{{ t("bp.retired") }}</span>
        </template>
        <template #cell-type="{ row }"><TypeLabel :type="row.bp?.type" :label="row.bp?.typeLabel" /></template>
        <template #cell-size="{ row }">{{ row.bp?.size ?? "—" }}</template>
        <template #cell-grade="{ row }">{{ row.bp?.gradeLetter ?? "—" }}</template>
        <template #cell-stats="{ row }"><span class="stats" :title="row.bp?.stats.join(', ')">{{ row.bp?.stats.join(", ") }}</span></template>
        <template #cell-owners="{ row }">
          <span class="owners" :title="row.owners.map(memberLabel).join(', ')">{{ row.owners.map(memberLabel).join(", ") }}</span>
        </template>
        <template #cell-actions="{ row }">
          <button type="button" class="icon-btn remove" :title="t('bp.remove')" :disabled="busy" @click.stop="pending = row.uuid">
            <Icon name="trash" :size="14" />
          </button>
        </template>
        <!-- Disabled without an unlock (kept in place); a click never reaches the row -->
        <template #cell-unlock="{ row }">
          <span class="unlock" @click.stop>
            <ChipButton :label="t('unlock.title')" icon="lock" :disabled="!row.bp?.unlockable" @click="unlocksOf = row" />
          </span>
        </template>
      </DataTable>
    </section>

    <ConfirmDialog
      v-if="pending"
      :title="t('confirm.bpRemove')"
      :subtitle="label(pending)"
      icon="trash"
      :buttons="confirmButtons"
      @choose="choose"
    />
    <UnlocksDialog v-if="unlocksOf" :uuid="unlocksOf.uuid" :name="unlocksOf.bp?.name ?? t('bp.unknown')" @close="unlocksOf = null" />
  </div>
</template>

<style scoped>
/* A bit narrower than the stock view's: the filters follow in the same row */
.filters .search {
  flex: 0 1 180px;
}

/* Centred in its fixed column (the cell is a flex box, see .sep in ui.css) */
.remove,
.unlock {
  margin: 0 auto;
}

.unlock {
  display: inline-flex;
}

.bp-name {
  font-weight: 600;
}

.owners,
.stats {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* The stats a blueprint can improve: background facts, kept quiet */
.stats {
  color: var(--text-3);
  font-size: 12px;
}
</style>
