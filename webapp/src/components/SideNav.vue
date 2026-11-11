<script setup lang="ts">
// The singleuser variant's navigation: a bar at the left edge from the window's top down to the footer (the online variant keeps
// the top bar). The logo (with the wordmark when wide), the nav groups of navigation.ts one below the other with a divider
// between them, the history as a group of its own (quieter), at the bottom the settings, a divider and the toggle between
// wide (icon and text, 208 px) and narrow (icons with a tooltip, 56 px). The choice is remembered; below 1000 px of window width
// the bar is narrow whatever the choice (it is not overwritten). The settings open the desktop shell's own window, in a plain
// browser they are the /settings page.
import { computed, onMounted, onUnmounted, ref } from "vue";
import { RouterLink, useRoute } from "vue-router";
import Icon from "../../../adminapp/src/components/Icon.vue";
import Tooltip from "../../../adminapp/src/components/Tooltip.vue";
import logo from "../../../adminapp/src/assets/logo-128.png";
import { capabilities } from "../capabilities";
import { t } from "../i18n";
import { parseSideMode, sideGroups, sideModeFor, SIDE_NARROW_BELOW, type SideMode } from "../navigation";
import { shell } from "../shell";

const STORE_KEY = "qm.sideMode";
const route = useRoute();

const groups = computed(() => sideGroups(capabilities.value));
// The attribute's mere presence marks a drag region (not in a browser): the logo's row is the window's top left corner
const drag = computed(() => (shell.available ? "" : undefined));

function stored(): SideMode {
  try {
    return parseSideMode(localStorage.getItem(STORE_KEY));
  } catch {
    return "wide";
  }
}

const choice = ref<SideMode>(stored());
const width = ref(window.innerWidth);
const forced = computed(() => width.value < SIDE_NARROW_BELOW);
const narrow = computed(() => sideModeFor(choice.value, width.value) === "narrow");

function toggle() {
  choice.value = choice.value === "wide" ? "narrow" : "wide";
  try {
    localStorage.setItem(STORE_KEY, choice.value);
  } catch { /* the choice holds for this run */ }
}

const onResize = () => (width.value = window.innerWidth);
onMounted(() => window.addEventListener("resize", onResize));
onUnmounted(() => window.removeEventListener("resize", onResize));
</script>

<template>
  <aside class="side" :class="{ narrow }">
    <div class="brand" :data-tauri-drag-region="drag">
      <img class="logo" :src="logo" alt="" :data-tauri-drag-region="drag" />
      <span v-if="!narrow" class="wordmark" :data-tauri-drag-region="drag">QUARTER<span class="accent">MASTER</span></span>
    </div>

    <nav class="nav">
      <template v-for="(group, i) in groups" :key="i">
        <div v-if="i > 0" class="sep" />
        <Tooltip v-for="tab in group" :key="tab.to" :text="narrow ? t(tab.label) : null">
          <RouterLink :to="tab.to" class="item" :class="{ narrow, secondary: tab.secondary, active: route.path === tab.to }" :aria-label="t(tab.label)">
            <Icon :name="tab.icon" :size="tab.secondary ? 15 : 16" />
            <span v-if="!narrow">{{ t(tab.label) }}</span>
          </RouterLink>
        </Tooltip>
      </template>
    </nav>

    <div class="grow" />

    <div class="nav">
      <Tooltip :text="narrow ? t('nav.settings') : null">
        <button v-if="shell.available" type="button" class="item" :class="{ narrow }" :aria-label="t('nav.settings')" @click="shell.openSettings()">
          <Icon name="settings" :size="16" />
          <span v-if="!narrow">{{ t("nav.settings") }}</span>
        </button>
        <RouterLink v-else to="/settings" class="item" :class="{ narrow, active: route.path === '/settings' }" :aria-label="t('nav.settings')">
          <Icon name="settings" :size="16" />
          <span v-if="!narrow">{{ t("nav.settings") }}</span>
        </RouterLink>
      </Tooltip>
      <div class="sep" />
      <Tooltip :text="narrow ? t('nav.expand') : null">
        <button type="button" class="item toggle" :class="{ narrow }" :disabled="forced" :aria-label="t(narrow ? 'nav.expand' : 'nav.collapse')" @click="toggle">
          <Icon :name="narrow ? 'chevron-right' : 'chevron-left'" :size="16" />
          <span v-if="!narrow">{{ t("nav.collapse") }}</span>
        </button>
      </Tooltip>
    </div>
  </aside>
</template>

<style scoped>
/* From the window's top to the footer (28 px, AppFooter): sticky, the page itself scrolls beside it */
.side {
  position: sticky;
  top: 0;
  align-self: flex-start;
  z-index: 30;
  width: 208px;
  height: calc(100vh - 28px);
  flex-shrink: 0;
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  padding: 0 8px 8px;
  background: var(--bg-surface);
  border-right: 1px solid var(--border-dim);
  user-select: none;
}

.side.narrow {
  width: 56px;
}

/* The logo sits at the same place in both modes */
.brand {
  height: 56px;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 0 2px;
}

.logo {
  width: 36px;
  height: 36px;
  flex-shrink: 0;
  display: block;
}

.wordmark {
  font-size: 13px;
  font-weight: 700;
  letter-spacing: 0.2em;
  white-space: nowrap;
  color: var(--text);
}

.wordmark .accent {
  color: var(--accent);
}

.nav {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.grow {
  flex: 1;
}

.sep {
  height: 1px;
  margin: 6px 4px;
  background: var(--border-dim);
}

.item {
  flex: 1;
  min-width: 0;
  height: 36px;
  box-sizing: border-box;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 0 12px;
  border: none;
  border-radius: var(--radius-control);
  background: transparent;
  color: var(--text-2);
  font-family: inherit;
  font-size: 14px;
  font-weight: 600;
  white-space: nowrap;
  text-decoration: none;
  cursor: pointer;
}

/* The icon sits at the same place in both modes (12 px in, 16 px wide = the centre of the 40 px button) */
.item.narrow {
  width: 40px;
  padding: 0;
  justify-content: center;
}

.item:hover {
  color: var(--text);
  text-decoration: none;
}

.item.secondary {
  font-size: 13px;
  font-weight: 400;
  color: color-mix(in srgb, var(--text-2) 70%, transparent);
}

.item.secondary:hover {
  color: var(--text);
}

.item.toggle {
  font-size: 12px;
  font-weight: 400;
}

.item:disabled {
  opacity: 0.5;
  cursor: default;
}

.item:disabled:hover {
  color: var(--text-2);
}

.item.active,
.item.active:hover {
  background: var(--accent);
  color: var(--accent-text);
}
</style>
