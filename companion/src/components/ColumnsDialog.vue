<script setup lang="ts">
// Which columns a table shows: a switch per column the user may hide (`hideable`), in the table's order;
// a change applies and is kept right away (useTableColumns). Opened from the icon button in the head of
// the table's action column (ColumnsButton.vue).
import { computed } from "vue";
import ConfirmDialog, { type ConfirmButton } from "../../../webapp/src/components/ConfirmDialog.vue";
import type { useTableColumns } from "../../../adminapp/src/tableColumns";
import { t } from "../i18n";

const props = defineProps<{ table: ReturnType<typeof useTableColumns> }>();
const emit = defineEmits<{ close: [] }>();

const choices = computed(() => props.table.all.value.filter((c) => c.hideable));
const buttons: ConfirmButton[] = [{ label: t("common.close"), kind: "primary", value: "close" }];
</script>

<template>
  <ConfirmDialog :title="t('columns.title')" icon="eye" :buttons="buttons" @choose="emit('close')">
    <div class="list">
      <label v-for="c in choices" :key="c.key" class="choice">
        <input type="checkbox" :checked="!table.hidden.value.has(c.key)" @change="table.toggleHidden(c.key)" />
        <span>{{ c.title ?? c.label }}</span>
      </label>
    </div>
  </ConfirmDialog>
</template>

<style scoped>
/* A long list scrolls inside the dialog */
.list {
  display: flex;
  flex-direction: column;
  gap: 4px;
  max-height: 50vh;
  overflow-y: auto;
  font-size: 12px;
}

.choice {
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--text);
  cursor: pointer;
}
</style>
