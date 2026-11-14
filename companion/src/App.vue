<script setup lang="ts">
// The title bar with the user (avatar, the name in its tooltip) and a button that opens the web app,
// or why the connection is down (chip only then; no reload button: a restart of the app reloads
// everything); below it the scan row (ScanBar.vue), then the side panel with the tabs (SideTabs.vue, at the left edge, icons like the
// web app's navigation) and the panels beside it: comps, stock (both InventoryPanel), refinery, mining, unlocks.
// The chips open the settings window (its own window, SettingsApp.vue; one at a time); it never opens by itself, also not
// while the app is not connected (the red chip says why). After a
// save ("config-changed") this window re-reads the config, re-checks the connection and the log state. While the server refuses
// the app's API contract number (the companion or the server is too old) only the update panel shows
// (no work until that changed). The local app's user has no name or avatar: nothing is shown for it. The footer's logo and
// version (and the update mark) open the App Update dialog (UpdateDialog.vue, appUpdate.ts), also over the update panel.
import { computed, onMounted, provide, ref } from "vue";
import { listen } from "@tauri-apps/api/event";
import Icon from "../../adminapp/src/components/Icon.vue";
import Tooltip from "../../adminapp/src/components/Tooltip.vue";
import { PICKER_LABELS } from "../../webapp/src/components/Picker.vue";
import InventoryPanel from "./components/InventoryPanel.vue";
import AppFooter from "./components/AppFooter.vue";
import MiningPanel from "./components/MiningPanel.vue";
import ScanBar from "./components/ScanBar.vue";
import SideTabs from "./components/SideTabs.vue";
import Toasts from "./components/Toasts.vue";
import ClipTip from "./components/ClipTip.vue";
import TopBar from "./components/TopBar.vue";
import UnlocksPanel from "./components/UnlocksPanel.vue";
import UpdateDialog from "./components/UpdateDialog.vue";
import UpdatePanel from "./components/UpdatePanel.vue";
import WindowEdges from "./components/WindowEdges.vue";
import { updateOpen, watchUpdate } from "./appUpdate";
import { AppError, appInfo, openSettingsWindow, openWebapp, outdated } from "./backend";
import { isKey, t } from "./i18n";
import { outdatedKeys } from "./connection";
import {
  config, connectError, connected, connection, connectionText, loadConfig, loadLog, meAvatar, meName, paired, refreshConnection,
  watchConnection, watchLog,
} from "./state";
import { watchRefinery } from "./refinerySync";
import { watchInventory } from "./inventorySync";
import { watchDebugReport } from "./debugReport";
import { tab, watchOverlay } from "./overlay";
import { watchScan } from "./scan";
import { watchMining } from "./mining";
import RefineryPanel from "./components/RefineryPanel.vue";
import { toastError } from "./toasts";

provide(PICKER_LABELS, { clear: t("pick.clear"), noMatch: t("pick.noMatch") });

const openSettings = () => openSettingsWindow().catch(toastError);
const ready = ref(false);
const info = ref<{ version: string } | null>(null);

// Why not connected, short (the full text in the tooltip)
const serverLabel = computed(() => {
  if (outdated.value) return t(outdatedKeys(outdated.value, connection.value).title);
  const key = `conn.short.${connectError.value instanceof AppError ? connectError.value.message : String(connectError.value)}`;
  return isKey(key) ? t(key) : t("conn.off");
});
// With the server in use: the configured one, or the local app's as last paired
const serverTip = computed(() => [connectionText.value, connection.value === "local" ? paired.value?.origin : config.value?.server]
  .filter(Boolean).join(" · "));

onMounted(async () => {
  try {
    info.value = await appInfo();
    await loadConfig();
    await refreshConnection();
  } catch (e) {
    toastError(e);
  }
  watchConnection();
  await watchUpdate().catch(toastError);
  // The settings window saved: its new config, the connection check and the log state (the game folder may differ)
  await listen("config-changed", () => void loadConfig().then(() => Promise.all([refreshConnection(), loadLog()])).catch(toastError))
    .catch(toastError);
  await watchLog().catch(toastError);
  await watchScan().catch(toastError);
  await watchRefinery().catch(toastError);
  await watchInventory().catch(toastError);
  await watchMining().catch(toastError);
  await watchDebugReport().catch(toastError);
  await watchOverlay().catch(toastError);
  // Not connected: the red tag in the top bar says why and opens the settings on a click; they never open by themselves
  ready.value = true;
});
</script>

<template>
  <div class="app">
    <TopBar @settings="openSettings">
      <Tooltip v-if="!connected && connectError" :text="serverTip">
        <button type="button" class="tag err problem" @click="openSettings">
          <Icon name="warning" :size="12" /> {{ serverLabel }}
        </button>
      </Tooltip>
      <div v-if="connected" class="account">
        <Tooltip v-if="meName || meAvatar" :text="meName">
          <img v-if="meAvatar" class="avatar" :src="meAvatar" alt="" />
          <span v-else class="avatar none"><Icon name="user" :size="14" /></span>
        </Tooltip>
        <!-- Only online: the local app is its own window on this PC, there is no web page to open -->
        <Tooltip v-if="connection !== 'local'" :text="t('webapp.open')">
          <button type="button" class="icon-btn" @click="openWebapp().catch(toastError)">
            <Icon name="external" :size="15" />
          </button>
        </Tooltip>
      </div>
    </TopBar>
    <ScanBar @settings="openSettings" />
    <main v-if="ready && outdated" class="main">
      <UpdatePanel :outdated="outdated" :current="info?.version ?? '?'" :connection="connection" />
    </main>
    <template v-else-if="ready">
      <div class="body">
        <SideTabs />
        <!-- All panels stay mounted (v-show): the unlocks panel's catalog and scan progress survive a tab switch -->
        <main class="main">
          <InventoryPanel v-show="tab === 'comps'" part="comps" />
          <InventoryPanel v-show="tab === 'stock'" part="stock" />
          <RefineryPanel v-show="tab === 'refinery'" />
          <MiningPanel v-show="tab === 'mining'" />
          <UnlocksPanel v-show="tab === 'unlocks'" />
        </main>
      </div>
    </template>
    <!-- Below everything, also while loading or outdated: the footer never moves -->
    <AppFooter class="app-foot" :version="info?.version ?? null" />
    <UpdateDialog v-if="updateOpen" />
    <Toasts />
    <ClipTip />    <WindowEdges grip />
  </div>
</template>

<style scoped>
.app {
  display: flex;
  flex-direction: column;
  height: 100vh;
}

/* The connection down: a tag, but a button (opens the settings) */
.problem {
  border: none;
  font-family: inherit;
  cursor: pointer;
}

/* The user and the web app button in the title bar, close together (the bar has little room) */
.account {
  display: flex;
  align-items: center;
  gap: 4px;
}

/* The user: the Discord avatar (the name in its tooltip: the bar has no room for it) */
.avatar {
  width: 24px;
  height: 24px;
  border-radius: 50%;
  display: block;
}

.avatar.none {
  display: grid;
  place-items: center;
  background: var(--bg-surface-2);
  color: var(--text-2);
}
/* The side panel and the main area below the scan row, down to the window's bottom */
.body {
  flex: 1;
  min-height: 0;
  display: flex;
}

/* At the window's bottom also while nothing above fills the height (loading) */
.app-foot {
  margin-top: auto;
}

/* Only the main area scrolls: the title bar, the scan row and the side panel stay put */
.main {
  min-width: 0;
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

/* The count after a panel's title: room for "999", so the filter chips after it stay put */
.main :deep(.panel > .head .head-count) {
  display: inline-block;
  min-width: 3ch;
  font-variant-numeric: tabular-nums;
}

</style>

<style>
/* Dialogs (teleported next to #app) sit near the top instead of 10vh down (made for the settings, which now
   have their own window). The id beats ConfirmDialog's scoped rule */
#app ~ .backdrop {
  padding-top: 16px;
}

/* The panels' tables: the web app's (ui.css .table, .row, ColumnHead's .cols-head), compact: less
   padding, the gap the panels pass to useTableColumns (8 px), smaller text. Head and rows share the
   symmetric padding, so the titles sit in the middle */
.table.compact {
  font-size: 12px;
}

.table.compact .row {
  gap: 8px;
  padding: 4px 16px;
  line-height: 1.35;
}

.table.compact .cols-head {
  min-height: 22px;
  font-size: 10.5px;
  letter-spacing: 0.06em;
}

.table.compact .data-row {
  cursor: default;
  user-select: text;
}

/* The line before the action columns (ColumnSpec.sep), in the middle of the smaller gap, over the
   whole row (ui.css: for 8 px padding and a 12 px gap) */
.table.compact .row > .sep {
  margin: -4px 0 -4px -4px;
  padding: 4px 0 4px 4px;
}

/* The display "thumbs" (ViewToggle): taller rows for the 48 px thumbnail column, larger text */
.table.compact.thumbs {
  font-size: 13px;
}

.table.compact.thumbs .row:not(.cols-head) {
  min-height: 48px;
}

/* The small thumbnail in front of a name: it never makes the 24 px rows higher */
.thumb.lead {
  margin: -4px 6px -4px 0;
}
</style>
