<script setup lang="ts">
// The slim bar at the top of the singleuser variant's content (right of the side bar, 44 px like the title bar): the drag region,
// the game version chip and, in the desktop shell, the window buttons. It never wraps. In a plain browser it is the same bar
// without window buttons and without drag attributes.
import { onMounted, onUnmounted, ref } from "vue";
import { gameLabel } from "../capabilities";
import { t } from "../i18n";
import { topbarHeight } from "../layout";
import { shell } from "../shell";
import WindowButtons from "./WindowButtons.vue";

// The attribute's mere presence marks a drag region (not in a browser)
const drag = shell.available ? "" : undefined;

// The toasts sit right below the bar (layout.ts)
const bar = ref<HTMLElement | null>(null);
const observer = new ResizeObserver(([e]) => (topbarHeight.value = e!.target.getBoundingClientRect().height));
onMounted(() => bar.value && observer.observe(bar.value));
onUnmounted(() => {
  observer.disconnect();
  topbarHeight.value = 0;
});
</script>

<template>
  <header ref="bar" class="slim" :data-tauri-drag-region="drag">
    <span class="grow" :data-tauri-drag-region="drag" />
    <!-- The game version of the installed data; a fixed width, so the dash and the number take the same room -->
    <span class="ver-chip fixed" :class="{ none: !gameLabel }" :title="t('nav.gameVersion')" :data-tauri-drag-region="drag"><span class="ver-label" :data-tauri-drag-region="drag">{{ t("nav.game") }}</span>{{ gameLabel ?? "–" }}</span>
    <WindowButtons />
  </header>
</template>

<style scoped>
.slim {
  position: sticky;
  top: 0;
  z-index: 30;
  height: 44px;
  flex-shrink: 0;
  box-sizing: border-box;
  display: flex;
  flex-wrap: nowrap;
  align-items: center;
  gap: 12px;
  padding: 0 8px 0 16px;
  background: var(--bg-base);
  user-select: none;
}

.grow {
  flex: 1;
  align-self: stretch;
}

.ver-chip {
  flex-shrink: 0;
}
</style>
