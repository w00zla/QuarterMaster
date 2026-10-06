<script setup lang="ts">
// Blueprints as a table like the admin UI's: scope "personal" (yours: add, remove) or an org (every
// blueprint its active members registered, with who has it). Filters: text, category, size, and in
// an org the member.
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import type {
  BlueprintListResponse, BlueprintOwner, BlueprintRequest, CatalogBlueprint, OkResponse, OrgBlueprintsResponse,
} from "../../../src/webapp/api-types";
import DataTable from "../../../adminapp/src/components/DataTable.vue";
import Icon from "../../../adminapp/src/components/Icon.vue";
import type { ColumnSpec } from "../../../adminapp/src/tableColumns";
import { useRouter } from "vue-router";
import { api } from "../api";
import { addToCrafting } from "../crafting";
import { blueprints, catalog } from "../catalog";
import ConfirmDialog, { type ConfirmButton } from "../components/ConfirmDialog.vue";
import Dropdown from "../components/Dropdown.vue";
import InfoTip from "../components/InfoTip.vue";
import TypeLabel from "../components/TypeLabel.vue";
import Picker from "../components/Picker.vue";
import { lang, t } from "../i18n";
import { memberLabel, orgOf } from "../orgs";
import { onServerMessage } from "../realtime";
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
const categoryOptions = computed(() => options(allRows.value.map((r) => r.bp?.category ?? t("bp.other")), t("filter.allCategories")));
const sizeOptions = computed(() => [
  { value: "", label: t("filter.allSizes") },
  ...[...new Set(allRows.value.map((r) => r.bp?.size).filter((s): s is number => s !== null && s !== undefined))]
    .sort((a, b) => a - b).map((s) => ({ value: String(s), label: `S${s}` })),
]);
const memberOptions = computed(() => [
  { value: "", label: t("filter.allMembers") },
  ...[...new Map(allRows.value.flatMap((r) => r.owners).map((o) => [o.userId, o]))].map(([value, o]) => ({ value, label: memberLabel(o) }))
    .sort((a, b) => byText(a.label, b.label)),
]);
// A choice the list no longer offers is dropped
watch(categoryOptions, (o) => { if (!o.some((x) => x.value === category.value)) category.value = ""; });
watch(sizeOptions, (o) => { if (!o.some((x) => x.value === size.value)) size.value = ""; });

const rows = computed(() => {
  const words = search.value.toLowerCase().split(/\s+/).filter(Boolean);
  return allRows.value.filter((r) => {
    if (category.value && (r.bp?.category ?? t("bp.other")) !== category.value) return false;
    if (size.value && String(r.bp?.size) !== size.value) return false;
    if (member.value && !r.owners.some((o) => o.userId === member.value)) return false;
    const hay = [r.bp?.label, r.bp?.category, ...r.owners.map(memberLabel)].join(" ").toLowerCase();
    return words.every((w) => hay.includes(w));
  });
});

// --- table -------------------------------------------------------------------------------------
const columns = computed<ColumnSpec[]>(() => [
  { key: "name", label: t("bp.col.name"), width: null },
  { key: "type", label: t("bp.col.type"), width: 160 },
  { key: "category", label: t("bp.col.category"), width: 170 },
  { key: "size", label: t("bp.col.size"), width: 64 },
  { key: "class", label: t("bp.col.class"), width: 130 },
  { key: "grade", label: t("bp.col.grade"), width: 72 },
  org.value ? { key: "owners", label: t("bp.col.owners"), width: 240 } : { key: "actions", label: "", width: 44, sortable: false, fixed: true, sep: true },
]);

function valueOf(r: Row, key: string): string | number {
  switch (key) {
    case "name": return r.bp?.name ?? t("bp.unknown");
    case "type": return r.bp?.typeLabel ?? "";
    case "category": return r.bp?.category ?? t("bp.other");
    case "size": return r.bp?.size ?? -1;
    case "class": return r.bp?.itemClass ?? "";
    case "grade": return r.bp?.gradeLetter ?? "";
    case "owners": return r.owners.length;
    default: return "";
  }
}

// --- add / remove (confirmed first, like every action) -----------------------------------------
const adding = ref<string | null>(null);
const addOptions = computed(() => {
  const owned = new Set(mine.value ?? []);
  return (catalog.value?.blueprints ?? [])
    .filter((b) => !b.isDefault && !b.retired && !owned.has(b.uuid))
    .map((b) => ({ value: b.uuid, label: b.label, hint: b.category ?? undefined }))
    .sort((a, b) => byText(a.label, b.label));
});
const label = (uuid: string) => blueprints.value.get(uuid)?.label ?? t("bp.unknown");

const pending = ref<{ action: "add" | "remove"; uuid: string } | null>(null);
// The add dialog: picking a blueprint moves on to the confirmation
const addOpen = ref(false);
const addButtons = computed<ConfirmButton[]>(() => [{ label: t("common.cancel"), kind: "outline", value: "cancel" }]);
watch(adding, (uuid) => {
  if (!uuid) return;
  adding.value = null;
  addOpen.value = false;
  pending.value = { action: "add", uuid };
});
const confirmButtons = computed<ConfirmButton[]>(() => [
  { label: t("common.cancel"), kind: "outline", value: "cancel" },
  { label: t("common.confirm"), kind: pending.value?.action === "remove" ? "danger" : "primary", value: "confirm", disabled: busy.value },
]);

async function choose(value: string) {
  const p = pending.value;
  if (value === "confirm" && p) {
    busy.value = true;
    try {
      const body: BlueprintRequest = { uuid: p.uuid };
      await api<OkResponse>(`/blueprints/${p.action}`, { method: "POST", body });
      toast(t(p.action === "add" ? "bp.added" : "bp.removed", { name: label(p.uuid) }));
      void loadMine();
    } catch (e) {
      toastError(e);
    } finally {
      busy.value = false;
    }
  }
  pending.value = null;
}

let unsubscribe = () => {};
onMounted(() => {
  void loadMine();
  unsubscribe = onServerMessage((m) => {
    if (m.type === "resync") {
      void loadMine();
      void loadOrg();
    } else if (m.type === "blueprints") {
      if (m.userId === me.value?.userId) void loadMine();
      // Anyone in the org may have added or removed one
      void loadOrg();
    } else if ((m.type === "members" && m.guildId === org.value?.guildId) || m.type === "profile") void loadOrg();
  });
});
onUnmounted(() => unsubscribe());
</script>

<template>
  <div class="page">
    <div v-if="me?.orgs.length" class="scope-bar">
      <button type="button" class="scope" :class="{ active: scope === 'personal' }" @click="scope = 'personal'">
        <Icon name="user" :size="16" /> {{ t("stock.personal") }}
      </button>
      <button v-for="o in me.orgs" :key="o.guildId" type="button" class="scope" :class="{ active: scope === o.guildId }" @click="scope = o.guildId">
        <Icon name="users" :size="16" /> {{ o.name }}
      </button>
    </div>

    <section class="panel unclipped">
      <div class="head">
        <Icon name="blueprint" :size="16" />
        <span class="head-title">{{ org ? t("bp.orgTitle", { org: org.name }) : t("bp.mine") }}</span>
        <button v-if="!org" type="button" class="btn small primary" :disabled="!catalog" @click="addOpen = true">
          <Icon name="plus" :size="14" /> {{ t("bp.add") }}
        </button>
      </div>
      <div class="filters">
        <label class="search">
          <Icon name="search" :size="14" />
          <input v-model="search" type="text" :placeholder="t('bp.search')" />
          <button v-if="search" type="button" class="clear" :title="t('pick.clear')" @click="search = ''">
            <Icon name="close" :size="12" />
          </button>
        </label>
        <Dropdown v-model="category" :options="categoryOptions" variant="chip" />
        <Dropdown v-model="size" :options="sizeOptions" variant="chip" />
        <Dropdown v-if="org" v-model="member" :options="memberOptions" variant="chip" />
        <span class="spacer" />
        <span class="head-count">{{ rows.length }} / {{ allRows.length }}</span>
      </div>
      <div v-if="org ? !orgEntries : !mine" class="empty-line">{{ t("common.loading") }}</div>
      <div v-else-if="!allRows.length" class="empty-line">{{ t(org ? "bp.orgNone" : "bp.none") }}</div>
      <DataTable
        v-else
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
          <InfoTip kind="blueprint" :uuid="row.uuid">{{ row.bp?.name ?? t("bp.unknown") }}</InfoTip>
          <span v-if="row.bp?.retired" class="tag err">{{ t("bp.retired") }}</span>
        </template>
        <template #cell-type="{ row }"><TypeLabel :type="row.bp?.type" :label="row.bp?.typeLabel" /></template>
        <template #cell-size="{ row }">{{ row.bp?.size ?? "—" }}</template>
        <template #cell-grade="{ row }">{{ row.bp?.gradeLetter ?? "—" }}</template>
        <template #cell-owners="{ row }">
          <span class="owners" :title="row.owners.map(memberLabel).join(', ')">{{ row.owners.map(memberLabel).join(", ") }}</span>
        </template>
        <template #cell-actions="{ row }">
          <button type="button" class="icon-btn remove" :title="t('bp.remove')" :disabled="busy" @click.stop="pending = { action: 'remove', uuid: row.uuid }">
            <Icon name="trash" :size="14" />
          </button>
        </template>
      </DataTable>
    </section>

    <ConfirmDialog v-if="addOpen" :title="t('bp.addTitle')" icon="plus" :buttons="addButtons" @choose="addOpen = false">
      <Picker v-model="adding" :options="addOptions" :placeholder="t('pick.blueprint')" />
    </ConfirmDialog>
    <ConfirmDialog
      v-if="pending"
      :title="t(pending.action === 'add' ? 'confirm.bpAdd' : 'confirm.bpRemove')"
      :subtitle="label(pending.uuid)"
      :icon="pending.action === 'add' ? 'plus' : 'trash'"
      :buttons="confirmButtons"
      @choose="choose"
    />
  </div>
</template>

<style scoped>
/* A bit narrower than the stock view's: the filters follow in the same row */
.filters .search {
  flex: 0 1 220px;
}

/* Centred in its fixed column (the cell is a flex box, see .sep in ui.css) */
.remove {
  margin: 0 auto;
}

.owners {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
