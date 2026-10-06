<script setup lang="ts">
// The app bar, after BindSight's: wordmark, one tab per area, the text
// language and the imported game build on the right.
import { computed } from "vue";
import { RouterLink } from "vue-router";
import Icon, { type IconName } from "./Icon.vue";
import Dropdown from "./Dropdown.vue";
import type { GameInfo } from "../../../src/adminapp/api-types";
import { lang } from "../lang";
import logo from "../assets/logo-128.png";

const props = defineProps<{ game: GameInfo | null; langs: string[] }>();

const TABS: { to: string; label: string; icon: IconName }[] = [
  { to: "/", label: "Overview", icon: "overview" },
  { to: "/blueprints", label: "Blueprints", icon: "blueprint" },
  { to: "/resources", label: "Resources", icon: "resource" },
  { to: "/items", label: "Items", icon: "item" },
  { to: "/localisation", label: "Localisation", icon: "texts" },
  { to: "/3rd-party", label: "3rd Party", icon: "link" },
];
// The tool, apart from the data views
const TOOL_TABS: typeof TABS = [{ to: "/crafting", label: "Crafting", icon: "crafter" }];
const isActive = (to: string, path: string) => (to === "/" ? path === "/" : path.startsWith(to));

const langOptions = computed(() => props.langs.map((l) => ({ value: l, label: l })));
</script>

<template>
  <header class="topbar">
    <div class="brand">
      <img class="logo" :src="logo" alt="" />
      <span class="wordmark">QUARTER<span class="accent">MASTER</span></span>
    </div>
    <nav class="tabs">
      <RouterLink v-for="t in TABS" :key="t.to" :to="t.to" class="tab" :class="{ active: isActive(t.to, $route.path) }">
        <Icon :name="t.icon" :size="16" />
        {{ t.label }}
      </RouterLink>
      <span class="tab-divider" />
      <RouterLink v-for="t in TOOL_TABS" :key="t.to" :to="t.to" class="tab" :class="{ active: isActive(t.to, $route.path) }">
        <Icon :name="t.icon" :size="16" />
        {{ t.label }}
      </RouterLink>
    </nav>
    <div class="spacer" />
    <!-- Imports sit with the game version they produced; the text language at the far right -->
    <RouterLink to="/imports" class="bar-btn" :class="{ active: isActive('/imports', $route.path) }">
      <Icon name="imports" :size="16" />
      Imports
    </RouterLink>
    <div v-if="game" class="version-chip mono" :title="`${game.branch}, import #${game.importId}`">
      {{ game.channel }} {{ game.label ?? "" }} · {{ game.build }}
    </div>
    <Dropdown v-model="lang" variant="mono" :options="langOptions" title="Language of game texts" />
  </header>
</template>

<style scoped>
.topbar {
  position: sticky;
  top: 0;
  z-index: 30;
  height: 56px;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  gap: 20px;
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
  /* Same as the user web app: nearly the bar's height (56 px); the file has 128 px, enough for HiDPI */
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

/* Two-tone like BindSight's: QUARTER white, MASTER blue. */
.wordmark .accent {
  color: var(--accent);
}

.tabs {
  display: flex;
  gap: 2px;
  background: var(--bg-base);
  border-radius: 6px;
  padding: 3px;
}

.tab {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 14px;
  border-radius: 4px;
  font-weight: 600;
  font-size: 14px;
  color: var(--text-2);
  text-decoration: none;
  white-space: nowrap;
}

.tab:hover {
  color: var(--text);
  text-decoration: none;
}

.tab-divider {
  align-self: center;
  width: 1px;
  height: 20px;
  margin: 0 4px;
  background: var(--border);
}

.tab.active {
  background: var(--accent);
  color: var(--accent-text);
}

.bar-btn {
  display: flex;
  align-items: center;
  gap: 8px;
  height: var(--h-chip);
  padding: 0 12px;
  border-radius: var(--radius-control);
  border: 1px solid rgba(255, 255, 255, 0.25);
  font-weight: 600;
  font-size: 13px;
  color: var(--text-2);
  text-decoration: none;
  white-space: nowrap;
}

.bar-btn:hover {
  color: var(--text);
  text-decoration: none;
}

.bar-btn.active {
  background: var(--accent);
  border-color: transparent;
  color: var(--accent-text);
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
}
</style>
