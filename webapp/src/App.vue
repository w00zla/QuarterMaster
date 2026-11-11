<script setup lang="ts">
import { computed, onMounted, provide, ref, watch } from "vue";
import { RouterView, useRoute, useRouter } from "vue-router";
import { PICKER_LABELS } from "./components/Picker.vue";
import AppFooter from "./components/AppFooter.vue";
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
import { capabilities, loadCapabilities, loginNone } from "./capabilities";
import { t } from "./i18n";
import { settings, startLocal, tile, updateNeeded } from "./local";
import { routeAllowed } from "./navigation";
import { startRealtime, stopRealtime } from "./realtime";
import { loadMe, status } from "./session";
import { shell } from "./shell";
import { firstRun } from "./settingsLogic";

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
// Live updates while logged in
watch(status, (s) => (s === "in" ? startRealtime() : stopRealtime()));

// A route the capabilities do not offer (opened before they were known, or UEX switched off meanwhile) leads home
watch(capabilities, (caps) => {
  if (!routeAllowed(route.path, caps)) void router.replace("/");
});

// First run without a usable game folder: the settings view opens by itself, once per start (the user can leave it)
let firstRunChecked = false;
const appShown = computed(() => loginNone.value && status.value === "in" && !tile.value.visible && !!settings.value);
watch(appShown, (shown) => {
  if (!shown || firstRunChecked || !settings.value) return;
  firstRunChecked = true;
  if (firstRun(settings.value)) void router.push("/settings");
}, { immediate: true });
</script>

<template>
  <div class="app">
    <!-- The frameless desktop window: the app bar is its title bar; where that is not shown, a bar with the window buttons -->
    <TitleBar v-if="!capabilities || tile.visible || status !== 'in'" />
    <WindowEdges />
    <div v-if="!capabilities" class="empty-line">{{ capsFailed ? t("error.backend") : "" }}</div>
    <!-- No game data yet (singleuser): the start tile instead of the app -->
    <StartTile v-else-if="tile.visible" :model="tile" :version="settings?.appVersion ?? null" />
    <template v-else>
      <template v-if="status === 'in'">
        <TopBar />
        <main class="main">
          <UpdateNotice v-if="updateNeeded" />
          <RouterView />
        </main>
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
</style>
