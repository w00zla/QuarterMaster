<script setup lang="ts" generic="T">
// A grid table with BindSight's column head: click to sort, drag to resize,
// widths and sort persist per table. Cells render `valueOf` unless a
// `#cell-<key>` slot is given. Rows are sorted here; filtering is the caller's.
import { computed } from "vue";
import ColumnHead from "./ColumnHead.vue";
import { sortRows, useTableColumns, type ColumnSpec, type SortState } from "../tableColumns";

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
}>();
const emit = defineEmits<{ select: [row: T] }>();

const cols = useTableColumns(props.storageKey, () => props.columns, props.defaultSort);
const sorted = computed(() => sortRows(props.rows, cols.sort.value, props.valueOf));
</script>

<template>
  <div class="table" :ref="cols.observe" :style="{ '--cols': cols.template.value, '--cols-min': `${cols.minWidth.value}px` }">
    <ColumnHead
      :columns="columns"
      :sort="cols.sort.value"
      @sort="cols.toggleSort"
      @resize="cols.startResize"
      @reset="cols.resetWidth"
    />
    <div
      v-for="r in sorted"
      :key="rowKey(r)"
      class="row data-row"
      :class="{ selected: selected === rowKey(r), ...(rowClass?.(r) ?? {}) }"
      @click="emit('select', r)"
    >
      <span v-for="c in columns" :key="c.key" :class="{ num: numeric?.includes(c.key), sep: c.sep }">
        <slot :name="`cell-${c.key}`" :row="r">{{ valueOf(r, c.key) }}</slot>
      </span>
    </div>
    <div v-if="!rows.length" class="empty-line">{{ emptyText ?? "No matches" }}</div>
  </div>
</template>
