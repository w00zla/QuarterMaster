<script setup lang="ts">
// A button set apart from the icon action buttons: an accent chip as high as the chips next to it
// (the former SCMDB link's look), e.g. "Freischaltung" and "Handel" at a row's right edge. Disabled =
// grey, not clickable (kept in place: no layout jumps). The click does not reach the row.
import Icon, { type IconName } from "../../../adminapp/src/components/Icon.vue";

defineProps<{ label: string; icon?: IconName; disabled?: boolean }>();
const emit = defineEmits<{ click: [] }>();
</script>

<template>
  <button type="button" class="chip-btn" :disabled="disabled" @click.stop="emit('click')">
    <Icon v-if="icon" :name="icon" :size="11" /> {{ label }}
  </button>
</template>

<style scoped>
.chip-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 20px;
  padding: 0 7px;
  border: 1px solid color-mix(in srgb, var(--accent) 60%, transparent);
  border-radius: var(--radius-control);
  background: transparent;
  color: var(--accent);
  font-family: inherit;
  font-size: 11px;
  font-weight: 600;
  white-space: nowrap;
  cursor: pointer;
}

.chip-btn:hover:not(:disabled) {
  border-color: var(--accent);
  background: color-mix(in srgb, var(--accent) 12%, transparent);
}

.chip-btn:disabled {
  border-color: var(--border);
  color: var(--text-3);
  cursor: default;
}
</style>
