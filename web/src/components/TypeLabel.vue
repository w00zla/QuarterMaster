<script setup lang="ts">
// An item type as icon plus display name; the technical type in a tooltip.
import Icon from "./Icon.vue";
import Tooltip from "./Tooltip.vue";
import { typeIcon } from "../typeIcons";

withDefaults(defineProps<{ type: string | null | undefined; label: string | null | undefined; size?: number }>(), { size: 14 });
</script>

<template>
  <Tooltip v-if="label" :text="type" mono>
    <span class="type-label">
      <Icon :name="typeIcon(type)" :size="size" class="type-icon" />
      <span class="type-text">{{ label }}</span>
    </span>
  </Tooltip>
</template>

<style scoped>
.type-label {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  max-width: 100%;
}

.type-icon {
  flex-shrink: 0;
  opacity: 0.8;
}

.type-text {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
