<script setup lang="ts">
// The slim bar at the top of the singleuser variant's content (right of the side bar, 56 px: the narrow side bar's width): the drag region,
// the game version chip, the settings button and, in the desktop shell, the window buttons. It never wraps. The settings button
// opens the shell's settings window, in a plain browser it is the /settings page. In a plain browser the bar has no window buttons
// and no drag attributes.
import { computed, onMounted, onUnmounted, ref } from "vue";
import { RouterLink, useRoute } from "vue-router";
import Icon from "../../../adminapp/src/components/Icon.vue";
import { gameLabel } from "../capabilities";
import { t } from "../i18n";
import { topbarHeight } from "../layout";
import { shell } from "../shell";
import WindowButtons from "./WindowButtons.vue";

const route = useRoute();
// The attribute's mere presence marks a drag region (not in a browser)
const drag = computed(() => (shell.available ? "" : undefined));

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
    <button v-if="shell.available" class="icon-btn" type="button" :title="t('nav.settings')" @click="shell.openSettings()"><Icon name="settings" :size="15" /></button>
    <RouterLink v-else to="/settings" class="icon-btn link-btn" :class="{ active: route.path === '/settings' }" :title="t('nav.settings')">
      <Icon name="settings" :size="15" />
    </RouterLink>
    <WindowButtons />
  </header>
</template>

<style scoped>
.slim {
  position: sticky;
  top: 0;
  z-index: 30;
  /* As high as the narrow side bar is wide (and as its logo row): the corner is a square, the line below runs on */
  height: 56px;
  flex-shrink: 0;
  box-sizing: border-box;
  display: flex;
  flex-wrap: nowrap;
  align-items: center;
  gap: 12px;
  padding: 0 8px 0 16px;
  /* Set apart from the content: the side bar's and the footer's ground, a line below */
  background: var(--bg-surface);
  border-bottom: 1px solid var(--border-dim);
  user-select: none;
}

.grow {
  flex: 1;
  align-self: stretch;
}

.ver-chip {
  flex-shrink: 0;
}

/* The settings page's button is a link (a route), looking like the icon button */
.link-btn {
  text-decoration: none;
}

.link-btn.active {
  border-color: var(--accent);
  color: var(--accent);
}
</style>
