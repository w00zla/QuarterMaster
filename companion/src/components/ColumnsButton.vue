<script setup lang="ts">
// The icon button that opens the column chooser (ColumnsDialog.vue), in the panel head left of the filter
// chips; the texts come in.
import { ref } from "vue";
import Icon from "./Icon.vue";
import Tooltip from "./Tooltip.vue";
import type { useTableColumns } from "../tableColumns";
import ColumnsDialog, { type ColumnsTexts } from "./ColumnsDialog.vue";

// `size`: the button's edge in px (16 in compact column titles)
const props = withDefaults(defineProps<{ table: ReturnType<typeof useTableColumns>; texts: ColumnsTexts; size?: number }>(), { size: 16 });
const open = ref(false);
</script>

<template>
  <Tooltip :text="texts.choose">
    <button type="button" class="icon-btn columns-btn" :style="{ width: `${props.size}px`, height: `${props.size}px` }" @click.stop="open = true">
      <Icon name="eye" :size="props.size - 5" />
    </button>
  </Tooltip>
  <ColumnsDialog v-if="open" :table="table" :texts="texts" @close="open = false" />
</template>
