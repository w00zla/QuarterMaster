<script setup lang="ts">
// The user's own scan filters (userFilters.ts, kept in inventorySync.ts): a term with wildcards and its
// kind (all, or one of the four) added in the row on top, the list below with a remove button each. What
// a filter matches makes no proposal. In the head the switch for all of them: off until it is turned on
// again or the app restarts. Every change applies right away.
import { computed, ref } from "vue";
import Dropdown from "./Dropdown.vue";
import Icon from "./Icon.vue";
import Tooltip from "./Tooltip.vue";
import ConfirmDialog, { type ConfirmButton } from "./ConfirmDialog.vue";
import { t } from "../i18n";
import { filtersOn, KIND_CLASS, KIND_ICON, setUserFilters, userFilters } from "../inventorySync";
import { FILTER_KINDS, type FilterKind } from "../userFilters";

const emit = defineEmits<{ close: [] }>();

const buttons = computed<ConfirmButton[]>(() => [{ label: t("common.close"), kind: "primary", value: "close" }]);
const kindText = (k: FilterKind) => (k === "all" ? t("filters.all") : t(`inventory.kind.${k}`));
const kindOptions = computed(() => FILTER_KINDS.map((k) => ({ value: k, label: kindText(k) })));
const kindClass = (k: FilterKind) => (k === "all" ? "" : KIND_CLASS[k]);
const kindIcon = (k: FilterKind) => (k === "all" ? "list" : KIND_ICON[k]);

const pattern = ref("");
const kind = ref<FilterKind>("all");

function add() {
  const p = pattern.value.trim();
  if (!p) return;
  // The same term for the same kind once
  if (!userFilters.value.some((f) => f.pattern.toLowerCase() === p.toLowerCase() && f.kind === kind.value)) setUserFilters([...userFilters.value, { pattern: p, kind: kind.value }]);
  pattern.value = "";
}

const remove = (i: number) => setUserFilters(userFilters.value.filter((_, j) => j !== i));
</script>

<template>
  <ConfirmDialog :title="t('filters.title')" icon="filter" :buttons="buttons" @choose="emit('close')">
    <template #head>
      <Tooltip :text="t('filters.allTip')">
        <button type="button" class="btn small outline all" :class="{ off: !filtersOn }" :disabled="!userFilters.length" @click="filtersOn = !filtersOn">
          <Icon :name="filtersOn ? 'check' : 'close'" :size="12" />
          <span class="swap"><span :class="{ hidden: !filtersOn }">{{ t("filters.on") }}</span><span :class="{ hidden: filtersOn }">{{ t("filters.off") }}</span></span>
        </button>
      </Tooltip>
    </template>
    <div class="hint">{{ t("filters.hint") }}</div>
    <form class="add" @submit.prevent="add">
      <input v-model="pattern" class="input mono" type="text" autocomplete="off" spellcheck="false" :placeholder="t('filters.pattern')" />
      <Dropdown v-model="kind" :options="kindOptions" variant="outline" />
      <button type="submit" class="btn outline" :disabled="!pattern.trim()"><Icon name="plus" :size="14" /> {{ t("filters.add") }}</button>
    </form>
    <div v-if="!userFilters.length" class="empty-line">{{ t("filters.empty") }}</div>
    <div v-else class="list" :class="{ off: !filtersOn }">
      <div v-for="(f, i) in userFilters" :key="`${f.kind}|${f.pattern}`" class="item">
        <span class="pattern mono">{{ f.pattern }}</span>
        <span class="tag" :class="kindClass(f.kind)"><Icon :name="kindIcon(f.kind)" :size="12" /> {{ kindText(f.kind) }}</span>
        <Tooltip :text="t('filters.remove')">
          <button type="button" class="btn small outline icon" @click="remove(i)"><Icon name="trash" :size="12" /></button>
        </Tooltip>
      </div>
    </div>
  </ConfirmDialog>
</template>

<style scoped>
/* The wildcards, quiet above the field */
.hint {
  margin-bottom: 4px;
  font-size: 11px;
  color: var(--text-3);
}

.add {
  display: flex;
  gap: 8px;
  margin-bottom: 12px;
}

/* As high as the dropdown and the button next to it */
.add .input {
  flex: 1;
  min-width: 0;
  height: var(--h-control);
}

/* A long list scrolls inside the dialog */
.list {
  display: flex;
  flex-direction: column;
  max-height: 40vh;
  overflow-y: auto;
  border: 1px solid var(--border-dim);
  border-radius: var(--radius-panel);
}

.item {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 32px;
  padding: 0 8px;
  border-top: 1px solid var(--border-dim);
  font-size: 12px;
}

.item:first-child {
  border-top: none;
}

.pattern {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text);
}

/* All filters off: the list dimmed, the switch dashed */
.list.off .item {
  opacity: 0.5;
}

.all.off {
  border-style: dashed;
  color: var(--text-3);
}

.mono {
  font-family: var(--font-mono);
}
</style>
