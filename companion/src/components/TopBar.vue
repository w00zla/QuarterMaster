<script setup lang="ts">
// The app bar, after BindSight's: the window has no native frame, the bar is the title bar
// (dragging, double-click maximizes) with what the app puts in (the user), the settings button and
// the window controls.
import { onMounted, onUnmounted, ref } from "vue";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { UnlistenFn } from "@tauri-apps/api/event";
// The same file and size as the desktop app's side bar (36 px from the 128 px logo): both headers look alike
import logo from "../../../adminapp/src/assets/logo-128.png";
import Icon from "../../../adminapp/src/components/Icon.vue";
import { t } from "../i18n";

const emit = defineEmits<{ settings: [] }>();

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
  await refreshMaximized();
  unlisten = await win.onResized(refreshMaximized);
});
onUnmounted(() => {
  unlisten?.();
});
</script>

<template>
  <header class="topbar" data-tauri-drag-region>
    <div class="brand" data-tauri-drag-region>
      <img class="logo" :src="logo" alt="" data-tauri-drag-region />
      <span class="wordmark" data-tauri-drag-region>QUARTER<span class="accent">MASTER</span></span>
      <span class="sub" data-tauri-drag-region>{{ t("app.name") }}</span>
    </div>
    <div class="spacer" data-tauri-drag-region />
    <!-- The user or why the connection is down, refresh and web app (App.vue) -->
    <slot />
    <!-- As the app's slim bar: the gear as an icon button, then the window buttons -->
    <button type="button" class="icon-btn" :title="t('settings.title')" @click="emit('settings')">
      <Icon name="settings" :size="15" />
    </button>
    <div class="win-btns">
      <button type="button" class="win-btn" :title="t('win.minimize')" @click="win.minimize()">
        <Icon name="minimize" :size="16" />
      </button>
      <button type="button" class="win-btn" :title="t(maximized ? 'win.restore' : 'win.maximize')" @click="win.toggleMaximize()">
        <Icon :name="maximized ? 'restore' : 'maximize'" :size="14" />
      </button>
      <button type="button" class="win-btn close" :title="t('win.close')" @click="win.close()">
        <Icon name="close" :size="16" />
      </button>
    </div>
  </header>
</template>

<style scoped>
.topbar {
  display: flex;
  align-items: center;
  /* The measures of the desktop app's header (SlimBar.vue and SideNav.vue's logo row): height, gaps, the logo 10 px in */
  gap: 12px;
  height: 56px;
  flex-shrink: 0;
  box-sizing: border-box;
  padding: 0 8px 0 10px;
  background: var(--bg-surface);
  border-bottom: 1px solid var(--border-dim);
  user-select: none;
}

.brand {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}

.logo {
  width: 36px;
  height: 36px;
  flex-shrink: 0;
  display: block;
}

.wordmark {
  font-weight: 700;
  font-size: 13px;
  letter-spacing: 0.16em;
  color: var(--text);
  white-space: nowrap;
}

.wordmark .accent {
  color: var(--accent);
}

/* Gives way first when the bar gets tight */
.sub {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text-2);
  font-size: 11px;
  letter-spacing: 0.1em;
  text-transform: uppercase;
}

.win-btns {
  display: flex;
  gap: 2px;
}

.win-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 36px;
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
