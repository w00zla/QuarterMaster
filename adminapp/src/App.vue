<script setup lang="ts">
import { onMounted, provide, ref, watch } from "vue";
import { RouterView, useRoute } from "vue-router";
import SideNav from "./components/SideNav.vue";
import TopBar from "./components/TopBar.vue";
import { get } from "./api";
import type { Meta, StatusResponse } from "../../src/adminapp/api-types";
import { lang } from "./lang";

const meta = ref<Meta>({ game: null, langs: ["en"] });
const error = ref("");
const checkHits = ref(0);

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

// The Status badge: refreshed on every page change (cheap enough, and a fix elsewhere shows at once)
async function loadHits() {
  try {
    checkHits.value = (await get<StatusResponse>("/status")).checkHits;
  } catch {
    // The badge is a convenience; the pages show the error
  }
}
const route = useRoute();
watch(() => route.name, loadHits);

onMounted(loadMeta);
</script>

<template>
  <div class="app">
    <SideNav :check-hits="checkHits" />
    <div class="column">
      <TopBar :game="meta.game" :langs="meta.langs" />
      <div v-if="error" class="empty-line">Backend not reachable: {{ error }}</div>
      <main v-else class="main">
        <RouterView />
      </main>
    </div>
  </div>
</template>

<style scoped>
.app {
  display: flex;
  height: 100%;
  min-width: 1100px;
}

.column {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
}

.main {
  flex: 1;
  min-height: 0;
  display: flex;
  gap: 12px;
  padding: 12px;
}
</style>
