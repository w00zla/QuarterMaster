<script setup lang="ts">
// The title bar, a row with the game log state (a small tag while found) and the refinery detection's
// (a tag: off, on without the game, on with the game; an icon toggle behind it), the user (avatar, name) or
// why the connection is down (chip only then) with a button that opens the web app, and the unlocks panel. The chips open
// the settings; the settings also open by themselves while the app is not connected (no
// server or token, or the token is refused). An app the server calls outdated shows only the update
// hint (no work until updated).
import { computed, onMounted, ref } from "vue";
import Icon from "../../adminapp/src/components/Icon.vue";
import Tooltip from "../../adminapp/src/components/Tooltip.vue";
import SettingsDialog from "./components/SettingsDialog.vue";
import Toasts from "./components/Toasts.vue";
import TopBar from "./components/TopBar.vue";
import UnlocksPanel from "./components/UnlocksPanel.vue";
import UpdatePanel from "./components/UpdatePanel.vue";
import WindowEdges from "./components/WindowEdges.vue";
import { AppError, appInfo, openWebapp, outdated } from "./backend";
import { isKey, t } from "./i18n";
import { config, connectError, connected, connectionText, loadConfig, log, meAvatar, meName, refreshConnection, watchConnection, watchLog } from "./state";
import { detecting, gameSeen, toggleDetect, watchRefinery } from "./refineryDrafts";
import RefineryPanel from "./components/RefineryPanel.vue";
import { toastError } from "./toasts";

const settingsOpen = ref(false);
const ready = ref(false);
const info = ref<{ version: string; platform: "windows" | "linux" } | null>(null);
const downloadUrl = computed(() => (info.value && outdated.value?.downloads[info.value.platform]) ?? null);

// Why not connected, short (the full text in the tooltip)
const serverLabel = computed(() => {
  const key = `conn.short.${connectError.value instanceof AppError ? connectError.value.message : String(connectError.value)}`;
  return isKey(key) ? t(key) : t("conn.off");
});
const serverTip = computed(() => [connectionText.value, config.value?.server].filter(Boolean).join(" · "));
// Found: just the path; missing: where it was looked for
// Refinery detection: off (red), on without the game (yellow), on with the game running (green)
const detectState = computed(() =>
  !detecting.value
    ? ({ cls: "err", icon: "close", label: "refinery.detectOff" } as const)
    : gameSeen.value
      ? ({ cls: "ok", icon: "check", label: "refinery.gameSeen" } as const)
      : ({ cls: "warn", icon: "warning", label: "refinery.noGame" } as const),
);
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
  await watchRefinery().catch(toastError);
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
      <span class="tag" :class="detectState.cls"><Icon :name="detectState.icon" :size="12" /> {{ t(detectState.label) }}</span>
      <Tooltip :text="t(detecting ? 'refinery.detectStop' : 'refinery.detectStart')">
        <button type="button" class="icon-btn" @click="toggleDetect">
          <Icon :name="detecting ? 'eye' : 'eye-off'" :size="14" />
        </button>
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
    <main v-else-if="ready" class="main">
      <RefineryPanel />
      <UnlocksPanel />
    </main>
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

.main {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  padding: 16px;
}
</style>
