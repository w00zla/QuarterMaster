<script setup lang="ts">
// The title bar of the companion's frameless side windows (settings, debug), as the desktop app's settings window has it
// (webapp/src/components/TitleBar.vue): 44 px, a drag region (double-click maximizes where the window can), at the left an
// icon and the title, at the right the window buttons. `closeOnly`: a window that can be neither minimized nor maximized
// (the settings).
import { onMounted, onUnmounted, ref } from "vue";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { UnlistenFn } from "@tauri-apps/api/event";
import Icon, { type IconName } from "../../../adminapp/src/components/Icon.vue";
import { t } from "../i18n";

const props = defineProps<{ icon: IconName; title: string; closeOnly?: boolean }>();

const win = getCurrentWindow();
const maximized = ref(false);
let unlisten: UnlistenFn | null = null;

async function refreshMaximized() {
  try {
    maximized.value = await win.isMaximized();
  } catch {
    maximized.value = false;
  }
}

onMounted(async () => {
  if (props.closeOnly) return;
  await refreshMaximized();
  unlisten = await win.onResized(refreshMaximized);
});
onUnmounted(() => unlisten?.());
</script>

<template>
  <header class="titlebar" data-tauri-drag-region>
    <span class="title"><Icon :name="icon" :size="16" />{{ title }}</span>
    <template v-if="!closeOnly">
      <button type="button" class="win-btn" :title="t('win.minimize')" @click="win.minimize()"><Icon name="minimize" :size="16" /></button>
      <button type="button" class="win-btn" :title="t(maximized ? 'win.restore' : 'win.maximize')" @click="win.toggleMaximize()">
        <Icon :name="maximized ? 'restore' : 'maximize'" :size="14" />
      </button>
    </template>
    <button type="button" class="win-btn close" :title="t('win.close')" @click="win.close()"><Icon name="close" :size="16" /></button>
  </header>
</template>

<style scoped>
.titlebar {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 2px;
  height: 44px;
  flex-shrink: 0;
  padding: 0 8px;
  background: var(--bg-base);
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
  white-space: nowrap;
  /* Clicks go to the bar below (the drag region), also on the icon */
  pointer-events: none;
}

.win-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 36px;
  padding: 0;
  border: none;
  border-radius: var(--radius-control);
  background: transparent;
  color: var(--text-2);
  cursor: pointer;
}

.win-btn:hover {
  background: var(--bg-surface-2);
  color: var(--text);
}

.win-btn.close:hover {
  background: var(--err);
  color: var(--accent-text);
}
</style>
