<script setup lang="ts">
// The icon button "Benutzerfilter" in the Gear and Resources heads after the kind filter: opens
// FiltersDialog.vue; lit (accent) while some filter applies, else a quiet icon.
import { ref } from "vue";
import Icon from "../../../adminapp/src/components/Icon.vue";
import Tooltip from "../../../adminapp/src/components/Tooltip.vue";
import { t } from "../i18n";
import { filtersActive } from "../inventorySync";
import FiltersDialog from "./FiltersDialog.vue";

const open = ref(false);
</script>

<template>
  <Tooltip :text="t('filters.title')">
    <button type="button" class="icon-btn filters-btn" :class="{ active: filtersActive }" :aria-pressed="filtersActive" @click.stop="open = true">
      <Icon name="filter" :size="14" />
    </button>
  </Tooltip>
  <FiltersDialog v-if="open" @close="open = false" />
</template>

<style scoped>
.filters-btn {
  width: 22px;
  height: 22px;
  border: 1px solid transparent;
  border-radius: var(--radius-control);
}

.filters-btn.active {
  border-color: color-mix(in srgb, var(--accent) 45%, transparent);
  background: color-mix(in srgb, var(--accent) 14%, transparent);
  color: var(--accent);
}
</style>
