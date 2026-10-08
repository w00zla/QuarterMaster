<script setup lang="ts">
// One headline number with its icon and label, an optional unit after it and a detail line below
// (the default slot; the line keeps its height when empty). "—" while there is no value yet, so
// nothing shifts when it arrives. `subtle`: a secondary tile, outlined instead of filled, value dimmed.
import Icon, { type IconName } from "../../../adminapp/src/components/Icon.vue";

defineProps<{ label: string; value: string | null; icon: IconName; unit?: string; subtle?: boolean }>();
</script>

<template>
  <div class="stat" :class="{ subtle }">
    <span class="label"><Icon :name="icon" :size="14" class="icon" />{{ label }}</span>
    <span class="value">{{ value ?? "—" }}<small v-if="unit && value !== null" class="unit">{{ unit }}</small></span>
    <span class="sub"><slot /></span>
  </div>
</template>

<style scoped>
.stat {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
  padding: 10px 14px;
  border-radius: var(--radius-control);
  background: var(--bg-surface-2);
}

.label {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--text-2);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.icon {
  flex-shrink: 0;
  opacity: 0.8;
}

.value {
  font-size: 22px;
  font-weight: 600;
  line-height: 1.2;
  color: var(--text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.unit {
  margin-left: 5px;
  font-size: 14px;
  font-weight: 500;
  color: var(--text-2);
}

/* As tall as a .tag, so a tag appearing in it shifts nothing */
.subtle {
  background: none;
  box-shadow: inset 0 0 0 1px var(--border-dim);
}

.subtle .value {
  color: var(--text-2);
}

.sub {
  height: 20px;
  font-size: 12px;
  line-height: 20px;
  color: var(--text-3);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.sub :slotted(.tag) {
  vertical-align: top;
}
</style>
