<script setup lang="ts">
// The title bar, a row with the game log state (a small tag while found) and the scan session's (a
// tag: off, running without the game, running with the game; started and stopped in the panels), the
// "Loading…" tag while an API call takes a while (state.ts loadingTexts), the
// user (avatar, name) or why the connection is down (chip only then) with a refresh button (reloads
// user, catalog, stock, jobs and blueprints: state.ts refreshAll) and a button that opens the web
// app, then a tab bar (icons like the debug window's) with the panels: warehouse, refinery, unlocks
// (the tab is the scan overlay's mode, overlay.ts).
// The chips open the settings; the settings also open by themselves while the app is not connected
// (no server or token, or the token is refused). An app the server calls outdated shows only the
// update hint (no work until updated).
import { computed, onMounted, provide, ref } from "vue";
import Icon from "../../adminapp/src/components/Icon.vue";
import Tooltip from "../../adminapp/src/components/Tooltip.vue";
import { PICKER_LABELS } from "../../webapp/src/components/Picker.vue";
import InventoryPanel from "./components/InventoryPanel.vue";
import SettingsDialog from "./components/SettingsDialog.vue";
import Toasts from "./components/Toasts.vue";
import TopBar from "./components/TopBar.vue";
import UnlocksPanel from "./components/UnlocksPanel.vue";
import UpdatePanel from "./components/UpdatePanel.vue";
import WindowEdges from "./components/WindowEdges.vue";
import { AppError, appInfo, openWebapp, outdated } from "./backend";
import { isKey, t } from "./i18n";
import {
  config, connectError, connected, connectionText, loadConfig, loadingTexts, log, meAvatar, meName, refreshAll, refreshConnection, refreshing, watchConnection, watchLog,
} from "./state";
import { watchRefinery } from "./refinerySync";
import { watchInventory } from "./inventorySync";
import { pickTab, scanState, tab, tabCounts, watchOverlay } from "./overlay";
import { watchScan } from "./scan";
import RefineryPanel from "./components/RefineryPanel.vue";
import { toastError } from "./toasts";

provide(PICKER_LABELS, { clear: t("pick.clear"), noMatch: t("pick.noMatch") });

const settingsOpen = ref(false);
const ready = ref(false);
// The panel tabs (also the scan overlay's modes, overlay.ts)
const TABS = [
  { id: "inventory", icon: "item", label: "inventory.title" },
  { id: "refinery", icon: "drop", label: "refinery.title" },
  { id: "unlocks", icon: "blueprint", label: "unlocks.title" },
] as const;
const info = ref<{ version: string; platform: "windows" | "linux" } | null>(null);
const downloadUrl = computed(() => (info.value && outdated.value?.downloads[info.value.platform]) ?? null);

// Why not connected, short (the full text in the tooltip)
const serverLabel = computed(() => {
  const key = `conn.short.${connectError.value instanceof AppError ? connectError.value.message : String(connectError.value)}`;
  return isKey(key) ? t(key) : t("conn.off");
});
const serverTip = computed(() => [connectionText.value, config.value?.server].filter(Boolean).join(" · "));
// Found: just the path; missing: where it was looked for
const logTip = computed(() => (!log.value ? null : log.value.found ? log.value.path : t("log.notFound", { path: log.value.path })));

onMounted(async () => {
  try {
    info.value = await appInfo();
    await loadConfig();
    await refreshConnection();
  } catch (e) {
    toastError(e);
  }
  watchConnection();
  await watchLog().catch(toastError);
  await watchScan().catch(toastError);
  await watchRefinery().catch(toastError);
  await watchInventory().catch(toastError);
  await watchOverlay().catch(toastError);
  ready.value = true;
  if (!connected.value && !outdated.value) settingsOpen.value = true;
});
</script>

<template>
  <div class="app">
    <TopBar @settings="settingsOpen = true" />
    <div class="states">
      <Tooltip v-if="log?.found" :text="logTip">
        <span class="tag ok"><Icon name="check" :size="12" /> {{ t("log.found") }}</span>
      </Tooltip>
      <Tooltip v-else-if="log" :text="logTip">
        <button type="button" class="tag warn problem" @click="settingsOpen = true">
          <Icon name="warning" :size="12" /> {{ t("log.missing") }}
        </button>
      </Tooltip>
      <span class="tag" :class="scanState.cls"><Icon :name="scanState.icon" :size="12" /> {{ scanState.text }}</span>
      <!-- Calls that take a while (thin line): what is loading in the tooltip -->
      <Tooltip v-if="loadingTexts.length" :text="loadingTexts.join(' · ')">
        <span class="tag spinning"><Icon name="refresh" :size="12" /> {{ t("load.tag") }}</span>
      </Tooltip>
      <div class="spacer" />
      <Tooltip v-if="!connected && connectError" :text="serverTip">
        <button type="button" class="tag err problem" @click="settingsOpen = true">
          <Icon name="warning" :size="12" /> {{ serverLabel }}
        </button>
      </Tooltip>
      <template v-if="connected">
        <span class="user">
          <img v-if="meAvatar" class="avatar" :src="meAvatar" alt="" />
          <span class="name">{{ meName }}</span>
        </span>
        <span class="divider" />
        <Tooltip :text="t('refresh.tip')">
          <button type="button" class="icon-btn" :class="{ spinning: refreshing }" :disabled="refreshing" @click="refreshAll">
            <Icon name="refresh" :size="14" />
          </button>
        </Tooltip>
        <Tooltip :text="t('webapp.open')">
          <button type="button" class="icon-btn" @click="openWebapp().catch(toastError)">
            <Icon name="external" :size="14" />
          </button>
        </Tooltip>
      </template>
    </div>
    <main v-if="ready && outdated" class="main">
      <UpdatePanel :outdated="outdated" :current="info?.version ?? '?'" :url="downloadUrl" />
    </main>
    <template v-else-if="ready">
      <nav class="tabs">
        <button v-for="x in TABS" :key="x.id" type="button" class="tab" :class="{ active: tab === x.id }" @click="pickTab(x.id)">
          <Icon :name="x.icon" :size="14" /> {{ t(x.label) }}
          <span class="tab-count">{{ tabCounts[x.id] }}</span>
        </button>
      </nav>
      <!-- All panels stay mounted (v-show): the unlocks panel's catalog and scan progress survive a tab switch -->
      <main class="main">
        <InventoryPanel v-show="tab === 'inventory'" />
        <RefineryPanel v-show="tab === 'refinery'" />
        <UnlocksPanel v-show="tab === 'unlocks'" />
      </main>
    </template>
    <SettingsDialog v-if="settingsOpen" @close="settingsOpen = false" />
    <Toasts />
    <WindowEdges />
  </div>
</template>

<style scoped>
.app {
  display: flex;
  flex-direction: column;
  height: 100vh;
}

/* Below the title bar (keeps it free and the app narrow): the game log state on the left, the
   connection (user or problem) on the right; the row keeps its height whatever it holds */
.states {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 40px;
  flex-shrink: 0;
  padding: 0 16px;
  background: var(--bg-surface);
  border-bottom: 1px solid var(--border-dim);
}

/* Problems (game log missing, connection down): a tag like "Data available", but a button (opens
   the settings) */
.problem {
  border: none;
  font-family: inherit;
  cursor: pointer;
}

/* The user like the web app's top bar: avatar and name */
.user {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  color: var(--text);
}

.divider {
  width: 1px;
  height: 20px;
  background: var(--border-dim);
}

/* The refresh button while it reloads and the loading tag: the icon turns */
.spinning svg {
  animation: spin 1s linear infinite;
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}

.avatar {
  width: 24px;
  height: 24px;
  border-radius: 50%;
  display: block;
}

.name {
  font-weight: 600;
  font-size: 13px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* Only the main area scrolls: the title bar, the state row with the user and the tabs stay put */
.main {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  padding: 16px;
  overflow: auto;
}

/* A panel head with its buttons sticks to the top while its rows scroll by (the panel must not clip
   for sticky to work against the main area) */
.main :deep(.panel) {
  overflow: visible;
}

.main :deep(.panel > .head) {
  position: sticky;
  top: 0;
  z-index: 2;
  background: var(--bg-surface);
  border-radius: var(--radius-panel) var(--radius-panel) 0 0;
}

/* The panel tabs below the state row, like the debug window's */
.tabs {
  display: flex;
  gap: 4px;
  flex-shrink: 0;
  padding: 6px 16px 0;
  background: var(--bg-surface);
  border-bottom: 1px solid var(--border-dim);
}

.tab {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px 12px;
  border: none;
  border-bottom: 2px solid transparent;
  background: none;
  color: var(--text-2);
  font: inherit;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
}

.tab.active {
  color: var(--text);
  border-bottom-color: var(--accent, currentColor);
}

/* How many rows the tab's table lists */
.tab-count {
  font-weight: 400;
  color: var(--text-3);
  font-variant-numeric: tabular-nums;
}
</style>
