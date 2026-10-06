<script setup lang="ts">
// The app bar (wordmark, connection, settings) and the unlocks panel. Settings open by themselves
// while the app is not connected (no server or token, or the token is refused). An app the server
// calls outdated shows only the update hint (no work until updated).
import { computed, onMounted, ref } from "vue";
import logo from "../../adminapp/src/assets/logo-128.png";
import Icon from "../../adminapp/src/components/Icon.vue";
import SettingsDialog from "./components/SettingsDialog.vue";
import Toasts from "./components/Toasts.vue";
import UnlocksPanel from "./components/UnlocksPanel.vue";
import { appInfo, openDownload, outdated } from "./backend";
import { t } from "./i18n";
import { connected, loadConfig, meName, refreshConnection } from "./state";
import { toastError } from "./toasts";

const settingsOpen = ref(false);
const ready = ref(false);
const info = ref<{ version: string; platform: "windows" | "linux" } | null>(null);
const downloadUrl = computed(() => (info.value && outdated.value?.downloads[info.value.platform]) ?? null);

onMounted(async () => {
  try {
    info.value = await appInfo();
    await loadConfig();
    await refreshConnection();
  } catch (e) {
    toastError(e);
  }
  ready.value = true;
  if (!connected.value && !outdated.value) settingsOpen.value = true;
});
</script>

<template>
  <div class="app">
    <header class="topbar">
      <div class="brand">
        <img class="logo" :src="logo" alt="" />
        <span class="wordmark">QUARTER<span class="accent">MASTER</span></span>
        <span class="sub">{{ t("app.name") }}</span>
      </div>
      <div class="spacer" />
      <span class="user" :class="{ off: !connected }">
        <Icon name="user" :size="14" />
        {{ connected ? meName : t("conn.off") }}
      </span>
      <button type="button" class="btn small outline square" :title="t('settings.title')" @click="settingsOpen = true">
        <Icon name="settings" :size="14" />
      </button>
    </header>
    <main v-if="ready && outdated" class="main">
      <section class="panel outdated">
        <div class="head"><Icon name="warning" :size="16" /><span class="head-title">{{ t("outdated.title") }}</span></div>
        <div class="body">
          <div>{{ t("outdated.text", { current: info?.version ?? "?", version: outdated.version }) }}</div>
          <button v-if="downloadUrl" type="button" class="btn primary" @click="openDownload(downloadUrl).catch(toastError)">
            <Icon name="imports" :size="14" /> {{ t("outdated.download", { version: outdated.version }) }}
          </button>
        </div>
      </section>
    </main>
    <main v-else-if="ready" class="main">
      <UnlocksPanel />
    </main>
    <SettingsDialog v-if="settingsOpen" @close="settingsOpen = false" />
    <Toasts />
  </div>
</template>

<style scoped>
.app {
  display: flex;
  flex-direction: column;
  height: 100vh;
}

.topbar {
  display: flex;
  align-items: center;
  gap: 12px;
  height: 56px;
  flex-shrink: 0;
  padding: 0 16px;
  background: var(--bg-surface);
  border-bottom: 1px solid var(--border-dim);
}

.brand {
  display: flex;
  align-items: center;
  gap: 10px;
}

.logo {
  width: 44px;
  height: 44px;
  display: block;
}

.wordmark {
  font-weight: 700;
  font-size: 16px;
  letter-spacing: 0.22em;
  color: var(--text);
  white-space: nowrap;
}

.wordmark .accent {
  color: var(--accent);
}

.sub {
  color: var(--text-2);
  font-size: 13px;
  letter-spacing: 0.1em;
  text-transform: uppercase;
}

.user {
  display: flex;
  align-items: center;
  gap: 6px;
  color: var(--text);
  font-size: 13px;
}

.user.off {
  color: var(--text-3);
}

.outdated {
  max-width: 520px;
  margin: 48px auto 0;
  width: 100%;
}

.outdated .body {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 16px;
  padding: 16px;
}

.main {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  padding: 16px;
}
</style>
