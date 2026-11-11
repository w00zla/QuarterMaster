<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, provide, ref, watch } from "vue";
import { RouterView, useRoute, useRouter } from "vue-router";
import { PICKER_LABELS } from "./components/Picker.vue";
import AppFooter from "./components/AppFooter.vue";
import SideNav from "./components/SideNav.vue";
import SlimBar from "./components/SlimBar.vue";
import StartTile from "./components/StartTile.vue";
import TitleBar from "./components/TitleBar.vue";
import Toasts from "./components/Toasts.vue";
import UpdateDialog from "./components/UpdateDialog.vue";
import UpdateNotice from "./components/UpdateNotice.vue";
import WindowEdges from "./components/WindowEdges.vue";
// Notices of actions from the bot and the companion app (listens to the realtime messages)
import "./history";
import TopBar from "./components/TopBar.vue";
import LoginView from "./views/LoginView.vue";
import SettingsView from "./views/SettingsView.vue";
import { capabilities, loadCapabilities, loginNone } from "./capabilities";
import { t } from "./i18n";
import { topbarHeight } from "./layout";
import { reloadAll, settings, startLocal, tile, updateNeeded } from "./local";
import { routeAllowed } from "./navigation";
import { startRealtime, stopRealtime } from "./realtime";
import { loadMe, status } from "./session";
import { shell } from "./shell";
import { firstRun } from "./settingsLogic";
import { settingsFitSize } from "./shellLogic";
import { listen, settingsWindow } from "./windows";

// The pickers' own texts (the component has no i18n: the companion app imports it too)
provide(PICKER_LABELS, computed(() => ({ clear: t("pick.clear"), noMatch: t("common.noMatch") })).value);

const route = useRoute();
const router = useRouter();
const capsFailed = ref(false);

// The capabilities first (what the server is decides what the app shows), then who is logged in
onMounted(async () => {
  while (!(await loadCapabilities())) {
    capsFailed.value = true;
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  capsFailed.value = false;
  if (loginNone.value) startLocal();
  await loadMe();
});

// The settings window (the shell's second window, docs/app.md) shows the settings panel and a title bar only: no live updates, no
// routes, no first-run opening. Everything below up to the template is the main window's.
if (!settingsWindow) {
  // Live updates while logged in
  watch(status, (s) => (s === "in" ? startRealtime() : stopRealtime()));

  // A route the capabilities do not offer (opened before they were known, or UEX switched off meanwhile) leads home
  watch(capabilities, (caps) => {
    if (!routeAllowed(route.path, caps)) void router.replace("/");
  });

  // First run without a usable game folder: the settings open by themselves (the shell's window, in a browser the page), once per
  // start (the user can leave them)
  let firstRunChecked = false;
  const appShown = computed(() => loginNone.value && status.value === "in" && !tile.value.visible && !!settings.value);
  watch(appShown, (shown) => {
    if (!shown || firstRunChecked || !settings.value) return;
    firstRunChecked = true;
    if (!firstRun(settings.value)) return;
    if (shell.available) shell.openSettings();
    else void router.push("/settings");
  }, { immediate: true });

  // What the settings window did (windows.ts): read everything again; its App Update button asks for the dialog here
  let stopListening = () => {};
  onMounted(() => {
    if (!shell.available) return;
    stopListening = listen((message) => {
      if (message.type === "changed") void reloadAll();
      else if (shell.updateAvailable) shell.openUpdate();
    });
  });
  onUnmounted(() => stopListening());
}

// The settings window sizes itself once: when the panel is on screen (and the fonts are in), its height is asked for, the shell
// sets that inner size and shows the window. The window cannot be resized, so nothing else changes it.
const win = ref<HTMLElement | null>(null);
const settingsReady = computed(() => status.value === "in" && loginNone.value && !!settings.value);
if (settingsWindow) {
  onMounted(() => (topbarHeight.value = 44));
  let fitted = false;
  watch(settingsReady, async (ready) => {
    if (!ready || fitted) return;
    fitted = true;
    await nextTick();
    try {
      await document.fonts.ready;
    } catch { /* measured with the fonts it has */ }
    await new Promise((resolve) => requestAnimationFrame(resolve));
    const size = settingsFitSize(win.value?.offsetHeight ?? 0);
    if (size) shell.fitSettings(size.width, size.height);
  }, { immediate: true });
}
</script>

<template>
  <!-- The settings window: the title bar (the title, the close button) and the panel -->
  <div v-if="settingsWindow" ref="win" class="settings-win">
    <TitleBar :title="t('nav.settings')" />
    <main class="settings-main">
      <SettingsView v-if="settingsReady" />
      <div v-else class="empty-line">{{ capabilities ? (status === "error" ? t("error.backend") : "") : (capsFailed ? t("error.backend") : "") }}</div>
    </main>
    <Toasts />
  </div>
  <div v-else class="app">
    <!-- The frameless desktop window: the app bar is its title bar; where that is not shown, a bar with the window buttons -->
    <TitleBar v-if="!capabilities || tile.visible || status !== 'in'" />
    <WindowEdges />
    <div v-if="!capabilities" class="empty-line">{{ capsFailed ? t("error.backend") : "" }}</div>
    <!-- No game data yet (singleuser): the start tile instead of the app -->
    <StartTile v-else-if="tile.visible" :model="tile" :version="settings?.appVersion ?? null" />
    <template v-else>
      <template v-if="status === 'in'">
        <!-- Singleuser: the navigation at the left edge and a slim bar above the content; online: the top bar -->
        <div v-if="loginNone" class="side-layout">
          <SideNav />
          <div class="side-col">
            <SlimBar />
            <main class="main side-main">
              <UpdateNotice v-if="updateNeeded" />
              <RouterView />
            </main>
          </div>
        </div>
        <template v-else>
          <TopBar />
          <main class="main">
            <UpdateNotice v-if="updateNeeded" />
            <RouterView />
          </main>
        </template>
      </template>
      <LoginView v-else-if="status === 'anon'" />
      <div v-else-if="status === 'error'" class="empty-line">{{ t("error.backend") }}</div>
      <AppFooter />
    </template>
    <UpdateDialog v-if="shell.updateOpen && shell.update" />
    <Toasts />
  </div>
</template>

<style scoped>
.app {
  display: flex;
  flex-direction: column;
  min-height: 100%;
}

.main {
  flex: 1;
  min-width: 0;
  padding: 16px;
}

/* The side bar beside the slim bar and the content; the footer below stays across the full width */
.side-layout {
  flex: 1;
  display: flex;
  min-width: 0;
}

.side-col {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
}

.side-main {
  padding: 0 16px 16px;
}

/* The settings window: as high as its content (that is what it measures), not as the window */
.settings-win {
  display: block;
}

.settings-main {
  padding: 0 16px 16px;
}
</style>
