<script setup lang="ts">
// Picks a blueprint, two ways in:
// - by result: search name, technical name, item type and size ("s2 quantum");
// - by ingredient: pick a resource or item, then one of the recipes using it.
// The manufacturer is shown, not searched.
import { computed, ref, watch } from "vue";
import type { BlueprintRow, ItemRow, ResourceRow } from "../../../src/web/api-types";
import type { CraftingUse } from "../../../src/webapp/api-types";
import Icon from "../../../web/src/components/Icon.vue";
import { api } from "../api";
import { useCrafting } from "../crafting";
import { unitText } from "../format";
import { lang, t } from "../i18n";
import { errorText } from "../toasts";
import TypeLabel from "./TypeLabel.vue";

const emit = defineEmits<{ add: [uuid: string] }>();

type Mode = "result" | "ingredient";
const mode = ref<Mode>("result");
const query = ref("");
const open = ref(false);

const blueprints = useCrafting<BlueprintRow[]>(() => "/crafting/blueprints");
// Ingredient lists load once the mode is used
const resources = useCrafting<ResourceRow[]>(() => (mode.value === "ingredient" ? "/crafting/resources" : null));
const items = useCrafting<ItemRow[]>(() => (mode.value === "ingredient" ? "/crafting/items" : null));

// Every word must match a field; "s2"/"size2" matches the size
function tokensMatch(q: string, fields: (string | null | undefined)[], size: number | null): boolean {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  return words.length > 0 && words.every((w) => {
    const sizeWord = /^s(?:ize)?(\d+)$/.exec(w);
    if (sizeWord) return size === Number(sizeWord[1]);
    return fields.some((f) => f?.toLowerCase().includes(w));
  });
}

const blueprintMatches = computed(() =>
  (blueprints.data.value ?? [])
    .filter((b) => !b.retired && tokensMatch(query.value, [b.name, b.key, b.outputClass, b.outputType, b.outputTypeLabel, b.outputSubTypeLabel], b.size))
    .sort((a, b) => a.name.localeCompare(b.name, lang.value))
    .slice(0, 15));

interface Ingredient { kind: "resource" | "item"; uuid: string; name: string; recipes: number }
const ingredientMatches = computed<Ingredient[]>(() => [
  ...(resources.data.value ?? []).filter((r) => r.usedIn > 0 && !r.retired)
    .map((r) => ({ kind: "resource" as const, uuid: r.uuid, name: r.name, recipes: r.usedIn, fields: [r.name, r.key] })),
  ...(items.data.value ?? []).filter((i) => i.asInput > 0 && !i.retired)
    .map((i) => ({ kind: "item" as const, uuid: i.uuid, name: i.name, recipes: i.asInput, fields: [i.name, i.className] })),
].filter((i) => tokensMatch(query.value, i.fields, null))
  .sort((a, b) => b.recipes - a.recipes || a.name.localeCompare(b.name, lang.value))
  .slice(0, 15).map(({ fields: _f, ...i }) => i));

// Second step of the ingredient way: the recipes using the picked ingredient
const picked = ref<Ingredient | null>(null);
const usages = ref<CraftingUse[] | null>(null);
const usagesError = ref("");

// The picked one is a reactive proxy: compare by key
const isPicked = (i: Ingredient) => picked.value?.kind === i.kind && picked.value.uuid === i.uuid;

async function loadUsages(i: Ingredient) {
  usages.value = null;
  usagesError.value = "";
  try {
    const found = await api<CraftingUse[]>(`/crafting/used-by?kind=${i.kind}&uuid=${i.uuid}&lang=${lang.value}`);
    if (isPicked(i)) usages.value = found;
  } catch (e) {
    if (isPicked(i)) usagesError.value = errorText(e);
  }
}

function pickIngredient(i: Ingredient) {
  picked.value = i;
  void loadUsages(i);
}

// Slot names follow the language
watch(lang, () => {
  if (picked.value) void loadUsages(picked.value);
});

function add(uuid: string) {
  emit("add", uuid);
  if (!picked.value) query.value = "";
  open.value = false;
}

function setMode(m: Mode) {
  mode.value = m;
  picked.value = null;
  usages.value = null;
  open.value = !!query.value;
}

function onKey(e: KeyboardEvent) {
  if (e.key === "Escape") open.value = false;
  if (e.key !== "Enter") return;
  if (mode.value === "result" && blueprintMatches.value[0]) add(blueprintMatches.value[0].uuid);
  else if (mode.value === "ingredient" && !picked.value && ingredientMatches.value[0]) pickIngredient(ingredientMatches.value[0]);
}

const showMenu = computed(() => open.value && (picked.value !== null || !!query.value.trim()));
const sizeGrade = (b: BlueprintRow) => [b.size !== null ? `S${b.size}` : "", b.gradeLetter ?? ""].filter(Boolean).join(" ");
const unit = (kind: string) => unitText(kind === "resource" ? "SCU" : "pcs");
const listError = computed(() => (mode.value === "result" ? blueprints.error.value : resources.error.value || items.error.value));
</script>

<template>
  <div class="bp-picker">
    <div class="chips">
      <button type="button" class="chip" :class="{ active: mode === 'result' }" @click="setMode('result')">{{ t("crafting.byResult") }}</button>
      <button type="button" class="chip" :class="{ active: mode === 'ingredient' }" @click="setMode('ingredient')">{{ t("crafting.byIngredient") }}</button>
    </div>
    <div class="search wide">
      <Icon name="search" :size="14" />
      <input
        v-model="query"
        type="text"
        autocomplete="off"
        spellcheck="false"
        :placeholder="mode === 'result' ? t('crafting.searchResult') : t('crafting.searchIngredient')"
        @focus="open = true"
        @input="open = true; picked = null"
        @keydown="onKey"
        @blur="open = false"
      />
    </div>

    <div v-if="showMenu" class="menu" @mousedown.prevent>
      <template v-if="mode === 'result'">
        <button v-for="b in blueprintMatches" :key="b.uuid" type="button" class="menu-item" @click="add(b.uuid)">
          <span class="menu-name">{{ b.name }}</span>
          <span class="menu-meta">
            <TypeLabel :type="b.outputType" :label="b.outputTypeLabel" :size="13" />
            <span class="mono">{{ sizeGrade(b) }}</span>
            <span class="faint">{{ b.manufacturer ?? "" }}</span>
          </span>
        </button>
        <div v-if="!blueprintMatches.length" class="menu-empty">
          {{ listError || (blueprints.loading.value ? t("common.loading") : t("common.noMatch")) }}
        </div>
      </template>

      <template v-else-if="!picked">
        <button v-for="i in ingredientMatches" :key="`${i.kind}:${i.uuid}`" type="button" class="menu-item" @click="pickIngredient(i)">
          <span class="menu-name">{{ i.name }}</span>
          <span class="menu-meta">
            <span class="tag">{{ i.kind === "resource" ? t("crafting.resource") : t("crafting.item") }}</span>
            <span class="faint">{{ t("crafting.recipes", { n: i.recipes }) }}</span>
            <Icon name="chevron-right" :size="14" />
          </span>
        </button>
        <div v-if="!ingredientMatches.length" class="menu-empty">
          {{ listError || (resources.loading.value || items.loading.value ? t("common.loading") : t("common.noMatch")) }}
        </div>
      </template>

      <template v-else>
        <button type="button" class="menu-back" @click="picked = null">
          <Icon name="chevron-left" :size="14" /> {{ t("crafting.recipesUsing") }} <strong>{{ picked.name }}</strong>
        </button>
        <div v-if="usagesError" class="menu-empty">{{ usagesError }}</div>
        <div v-else-if="!usages" class="menu-empty">{{ t("common.loading") }}</div>
        <button v-for="(u, n) in usages ?? []" :key="n" type="button" class="menu-item" @click="add(u.uuid)">
          <span class="menu-name">{{ u.name }}</span>
          <span class="menu-meta">
            <span class="faint">{{ u.slot }}</span>
            <span class="mono">{{ u.quantity }} {{ unit(picked.kind) }}</span>
            <span v-if="u.minQuality > 1" class="tag">{{ t("crafting.minQ", { q: u.minQuality }) }}</span>
          </span>
        </button>
      </template>
    </div>
  </div>
</template>

<style scoped>
.bp-picker {
  position: relative;
  display: flex;
  align-items: center;
  gap: 8px;
}

.search.wide {
  width: 300px;
}

.menu {
  position: absolute;
  top: calc(100% + 4px);
  left: 0;
  z-index: 20;
  width: 560px;
  max-height: 440px;
  overflow: auto;
  padding: 4px;
  border-radius: var(--radius-control);
  border: 1px solid var(--border);
  background: var(--bg-surface-2);
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.4);
  box-sizing: border-box;
}

.menu-item {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  gap: 2px 12px;
  width: 100%;
  padding: 6px 10px;
  border: none;
  border-radius: var(--radius-control);
  background: transparent;
  color: var(--text);
  font-family: inherit;
  font-size: 13px;
  text-align: left;
  cursor: pointer;
}

.menu-item:hover {
  background: var(--bg-surface-3);
}

.menu-name {
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.menu-meta {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  color: var(--text-2);
}

.menu-back {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  padding: 6px 10px;
  border: none;
  border-bottom: 1px solid var(--border-dim);
  background: transparent;
  color: var(--text-2);
  font-family: inherit;
  font-size: 12px;
  cursor: pointer;
}

.menu-back strong {
  color: var(--text);
}

.menu-empty {
  padding: 10px;
  color: var(--text-3);
  font-size: 13px;
}

/* Phones: mode chips above the search box, which takes the full width; the list below spans it,
   meta under the name */
@media (max-width: 640px) {
  .bp-picker {
    flex-wrap: wrap;
  }

  .search.wide {
    flex: 1 1 100%;
    width: auto;
  }

  .menu {
    width: 100%;
  }

  .menu-item {
    grid-template-columns: minmax(0, 1fr);
  }

  .menu-meta {
    flex-wrap: wrap;
  }
}
</style>
