<script setup lang="ts">
// The bar above every page: the page's name, the imported game build and the text language.
import { computed } from "vue";
import { useRoute } from "vue-router";
import Dropdown from "./Dropdown.vue";
import type { GameInfo } from "../../../src/adminapp/api-types";
import { lang } from "../lang";

const props = defineProps<{ game: GameInfo | null; langs: string[] }>();

const route = useRoute();
const langOptions = computed(() => props.langs.map((l) => ({ value: l, label: l })));
</script>

<template>
  <header class="topbar">
    <span class="title">{{ route.meta.title ?? "" }}</span>
    <div class="spacer" />
    <RouterLink v-if="game" to="/imports" class="version-chip mono" :title="`${game.branch}, import #${game.importId}`">
      {{ game.channel }} {{ game.label ?? "" }} · {{ game.build }}
    </RouterLink>
    <Dropdown v-model="lang" variant="mono" :options="langOptions" title="Language of game texts" />
  </header>
</template>

<style scoped>
.topbar {
  height: 52px;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 0 16px;
  background: var(--bg-surface);
  border-bottom: 1px solid var(--border-dim);
}

.title {
  font-weight: 700;
  font-size: 16px;
  color: var(--text);
}

.version-chip {
  display: flex;
  align-items: center;
  height: var(--h-chip);
  padding: 0 12px;
  border-radius: var(--radius-control);
  background: var(--bg-surface-2);
  font-size: 13px;
  color: var(--text-2);
  white-space: nowrap;
  text-decoration: none;
}

.version-chip:hover {
  color: var(--text);
  text-decoration: none;
}
</style>
