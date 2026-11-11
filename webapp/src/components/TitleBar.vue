<script setup lang="ts">
// The title bar of the frameless desktop window where the app bar is not shown (the start tile, the server not reachable):
// a drag region and the window buttons. Rendered only in the desktop shell. With `title` it is the settings window's bar: the
// settings icon and the title at the left and only the close button.
import Icon from "../../../adminapp/src/components/Icon.vue";
import { shell } from "../shell";
import WindowButtons from "./WindowButtons.vue";

defineProps<{ title?: string }>();
</script>

<template>
  <header v-if="shell.available" class="titlebar" data-tauri-drag-region>
    <span v-if="title" class="title" data-tauri-drag-region><Icon name="settings" :size="16" />{{ title }}</span>
    <WindowButtons :close-only="!!title" />
  </header>
</template>

<style scoped>
.titlebar {
  position: sticky;
  top: 0;
  z-index: 30;
  display: flex;
  align-items: center;
  justify-content: flex-end;
  height: 44px;
  flex-shrink: 0;
  padding: 0 8px;
  user-select: none;
}

.title {
  margin-right: auto;
  padding-left: 8px;
  display: inline-flex;
  align-items: center;
  gap: 8px;
  font-size: 14px;
  font-weight: 600;
  color: var(--text);
  /* Clicks go to the bar below (the drag region), also on the icon */
  pointer-events: none;
}
</style>
