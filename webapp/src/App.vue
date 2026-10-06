<script setup lang="ts">
import { onMounted, watch } from "vue";
import { RouterView } from "vue-router";
import TopBar from "./components/TopBar.vue";
import LoginView from "./views/LoginView.vue";
import { t } from "./i18n";
import { startRealtime, stopRealtime } from "./realtime";
import { loadMe, status } from "./session";

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
  padding: 16px;
}
</style>
