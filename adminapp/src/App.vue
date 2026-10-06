<script setup lang="ts">
import { onMounted, provide, ref } from "vue";
import { RouterView } from "vue-router";
import TopBar from "./components/TopBar.vue";
import { get } from "./api";
import type { Meta } from "../../src/adminapp/api-types";
import { lang } from "./lang";

const meta = ref<Meta>({ game: null, langs: ["en"] });
const error = ref("");

async function loadMeta() {
  try {
    meta.value = await get<Meta>("/meta");
    if (!meta.value.langs.includes(lang.value)) lang.value = "en";
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  }
}
provide("meta", meta);
// After an import the game version and the languages may change
provide("reloadMeta", loadMeta);

onMounted(loadMeta);
</script>

<template>
  <div class="app">
    <TopBar :game="meta.game" :langs="meta.langs" />
    <div v-if="error" class="empty-line">Backend not reachable: {{ error }}</div>
    <main v-else class="main">
      <RouterView />
    </main>
  </div>
</template>

<style scoped>
.app {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-width: 1100px;
}

.main {
  flex: 1;
  min-height: 0;
  display: flex;
  gap: 12px;
  padding: 12px;
}
</style>
