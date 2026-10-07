<script setup lang="ts">
// Header row of a grid table: click a column to sort, drag the grip at its
// right edge to resize that column, double-click the grip to reset the width.
// Fixed columns and the filler (fillerKey) have no grip. The root carries the parent's `.row.cols-head`
// styling; the grid template comes from the parent's `--cols` variable.
import HelpTip from "./HelpTip.vue";
import Icon, { type IconName } from "./Icon.vue";
import { computed } from "vue";
import { fillerKey, type ColumnSpec, type SortState } from "../tableColumns";

const props = defineProps<{ columns: ColumnSpec[]; sort: SortState }>();
const filler = computed(() => fillerKey(props.columns));
const emit = defineEmits<{ sort: [key: string]; resize: [key: string, e: MouseEvent]; reset: [key: string] }>();
</script>

<template>
  <div class="row cols-head">
    <span
      v-for="c in columns"
      :key="c.key"
      class="col"
      :class="{ sortable: c.sortable !== false, active: c.sortable !== false && sort.key === c.key, sep: c.sep }"
      @click="c.sortable !== false && emit('sort', c.key)"
    >
      <Icon v-if="c.icon" :name="c.icon as IconName" :size="13" class="col-icon" />
      <span class="txt">{{ c.label }}</span>
      <span v-if="c.note" class="txt note" :class="{ dim: c.dim }">{{ c.note }}</span>
      <HelpTip v-if="c.help" :text="c.help" />
      <!-- A non-sortable column never shows a sort, whatever the state says. -->
      <Icon
        v-if="c.sortable !== false && sort.key === c.key"
        :name="sort.dir === 'asc' ? 'chevron-up' : 'chevron-down'"
        :size="12"
      />
      <span
        v-if="!c.fixed && c.key !== filler"
        class="grip"
        @mousedown.stop.prevent="emit('resize', c.key, $event)"
        @dblclick.stop="emit('reset', c.key)"
        @click.stop
      />
    </span>
  </div>
</template>

<style scoped>
.col {
  position: relative;
  display: flex;
  align-items: center;
  gap: 4px;
  min-width: 0;
  user-select: none;
}

.col.sortable {
  cursor: pointer;
}

.col.sortable:hover {
  color: var(--text);
}

.col-icon {
  flex-shrink: 0;
}

.txt {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
/* The warning stays whole; the label gives way. */
.note {
  flex-shrink: 0;
  color: var(--warn);
}

.note.dim {
  color: var(--text-3);
}


/* Sits in the 12px column gap, right of the cell. */
.grip {
  position: absolute;
  top: -8px;
  bottom: -8px;
  right: -9px;
  width: 9px;
  cursor: col-resize;
}

.grip::after {
  content: "";
  position: absolute;
  top: 0;
  bottom: 0;
  left: 4px;
  width: 1px;
  background: var(--border);
}

.grip:hover::after {
  left: 3px;
  width: 2px;
  background: var(--accent);
}
</style>
