<script setup lang="ts" generic="T">
// A grid table with BindSight's column head: click to sort, drag to resize,
// widths and sort persist per table. Cells render `valueOf` unless a
// `#cell-<key>` slot is given; `#col-<key>` adds to a column's head (gets the table's columns as
// `table`, e.g. for the column chooser; also exposed as `table`). Columns the user hid (`hideable`) are
// left out. Rows are sorted here; filtering is the caller's. `thumbs`: in the view 'thumbs' (the table's
// `view`) a thumbnail column comes first (THUMB_COLUMN, its cells from `#cell-thumb`).
import { computed, ref, watch } from "vue";
import ColumnHead from "./ColumnHead.vue";
import { sortRows, THUMB_COLUMN, useTableColumns, type ColumnSpec, type SortState } from "../tableColumns";

const props = defineProps<{
  storageKey: string;
  columns: ColumnSpec[];
  rows: T[];
  defaultSort: SortState;
  rowKey: (row: T) => string;
  valueOf: (row: T, key: string) => string | number;
  selected?: string | null;
  rowClass?: (row: T) => Record<string, boolean>;
  emptyText?: string;
  // Right-aligned, tabular figures
  numeric?: string[];
  thumbs?: boolean;
}>();
const emit = defineEmits<{ select: [row: T] }>();

// The view lives in the columns' state, which reads the columns while it is created: mirrored into this flag
const thumbView = ref(false);
const cols = useTableColumns(props.storageKey, () => (props.thumbs && thumbView.value ? [THUMB_COLUMN, ...props.columns] : props.columns), props.defaultSort);
watch(cols.view, (v) => (thumbView.value = v === "thumbs"), { immediate: true });
const sorted = computed(() => sortRows(props.rows, cols.sort.value, props.valueOf));
// The columns' state for a chooser outside the table (a template ref's `table`)
defineExpose({ table: cols });
</script>

<template>
  <div class="table" :class="{ 'view-thumbs': thumbs && thumbView }" :ref="cols.observe" :style="{ '--cols': cols.template.value, '--cols-min': `${cols.minWidth.value}px` }">
    <ColumnHead
      :columns="cols.columns.value"
      :sort="cols.sort.value"
      @sort="cols.toggleSort"
      @resize="cols.startResize"
      @reset="cols.resetWidth"
    >
      <template v-for="c in cols.columns.value" :key="c.key" #[`col-${c.key}`]>
        <slot :name="`col-${c.key}`" :table="cols" />
      </template>
    </ColumnHead>
    <div
      v-for="r in sorted"
      :key="rowKey(r)"
      class="row data-row"
      :class="{ selected: selected === rowKey(r), ...(rowClass?.(r) ?? {}) }"
      @click="emit('select', r)"
    >
      <span v-for="c in cols.columns.value" :key="c.key" :class="{ num: numeric?.includes(c.key), sep: c.sep }">
        <slot :name="`cell-${c.key}`" :row="r">{{ valueOf(r, c.key) }}</slot>
      </span>
    </div>
    <div v-if="!rows.length" class="empty-line">{{ emptyText ?? "No matches" }}</div>
  </div>
</template>
