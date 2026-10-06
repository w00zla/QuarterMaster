<script setup lang="ts">
// One headline number with its icon and label; "—" while there is none yet, so nothing shifts when it arrives.
import Icon, { type IconName } from "../../../web/src/components/Icon.vue";

defineProps<{ label: string; value: string | null; icon: IconName }>();
</script>

<template>
  <div class="stat">
    <span class="label"><Icon :name="icon" :size="14" class="icon" />{{ label }}</span>
    <span class="value">{{ value ?? "—" }}</span>
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
</style>
