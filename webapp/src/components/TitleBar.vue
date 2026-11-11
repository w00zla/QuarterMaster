<script setup lang="ts">
// The title bar of the frameless desktop window where the app bar is not shown (the start tile, the server not reachable):
// a drag region and the window buttons. Rendered only in the desktop shell.
import { shell } from "../shell";
import WindowButtons from "./WindowButtons.vue";
</script>

<template>
  <header v-if="shell.available" class="titlebar" data-tauri-drag-region>
    <WindowButtons />
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
</style>
