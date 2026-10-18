<script setup lang="ts">
import { computed, onMounted, provide, watch } from "vue";
import { RouterView } from "vue-router";
import { PICKER_LABELS } from "./components/Picker.vue";
import AppFooter from "./components/AppFooter.vue";
import Toasts from "./components/Toasts.vue";
// Notices of actions from the bot and the companion app (listens to the realtime messages)
import "./history";
import TopBar from "./components/TopBar.vue";
import LoginView from "./views/LoginView.vue";
import { t } from "./i18n";
import { startRealtime, stopRealtime } from "./realtime";
import { loadMe, status } from "./session";

// The pickers' own texts (the component has no i18n: the companion app imports it too)
provide(PICKER_LABELS, computed(() => ({ clear: t("pick.clear"), noMatch: t("common.noMatch") })).value);

onMounted(loadMe);
// Live updates while logged in
watch(status, (s) => (s === "in" ? startRealtime() : stopRealtime()));
</script>

<template>
  <div class="app">
    <template v-if="status === 'in'">
      <TopBar />
      <main class="main">
        <RouterView />
      </main>
    </template>
    <LoginView v-else-if="status === 'anon'" />
    <div v-else-if="status === 'error'" class="empty-line">{{ t("error.backend") }}</div>
    <AppFooter />
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
