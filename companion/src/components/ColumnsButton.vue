<script setup lang="ts">
// The icon button in the head of a table's action column: opens the column chooser (ColumnsDialog.vue).
import { ref } from "vue";
import Icon from "../../../adminapp/src/components/Icon.vue";
import Tooltip from "../../../adminapp/src/components/Tooltip.vue";
import type { useTableColumns } from "../../../adminapp/src/tableColumns";
import { t } from "../i18n";
import ColumnsDialog from "./ColumnsDialog.vue";

defineProps<{ table: ReturnType<typeof useTableColumns> }>();
const open = ref(false);
</script>

<template>
  <Tooltip :text="t('columns.choose')">
    <button type="button" class="icon-btn columns-btn" @click.stop="open = true"><Icon name="eye" :size="11" /></button>
  </Tooltip>
  <ColumnsDialog v-if="open" :table="table" @close="open = false" />
</template>

<style scoped>
/* Small in the compact column titles; an eye: which columns are shown */
.columns-btn {
  width: 16px;
  height: 16px;
}
</style>
