<script setup lang="ts">
// Switches a table's list view: compact (a small thumbnail next to the name) or thumbnails (taller rows);
// kept with the table's columns (tableColumns.ts `view`). Next to the ColumnsButton; the texts come in.
import Icon from "./Icon.vue";
import Tooltip from "./Tooltip.vue";
import type { useTableColumns } from "../tableColumns";

export interface ViewTexts {
  // Tooltip: what a click switches on
  toThumbs: string;
  toCompact: string;
}

// `size`: the button's edge in px, as for the ColumnsButton
const props = withDefaults(defineProps<{ table: ReturnType<typeof useTableColumns>; texts: ViewTexts; size?: number }>(), { size: 16 });
</script>

<template>
  <Tooltip :text="table.view.value === 'compact' ? texts.toThumbs : texts.toCompact">
    <button
      type="button"
      class="icon-btn view-btn"
      :style="{ width: `${props.size}px`, height: `${props.size}px` }"
      :aria-pressed="table.view.value === 'thumbs'"
      @click.stop="table.toggleView()"
    >
      <Icon :name="table.view.value === 'compact' ? 'list-large' : 'list'" :size="props.size - 5" />
    </button>
  </Tooltip>
</template>
