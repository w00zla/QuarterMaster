<script setup lang="ts">
// The singleuser variant's navigation: a bar at the left edge below the header (SlimBar.vue, which carries the logo) down to the
// footer (the online variant keeps the top bar). The nav groups of navigation.ts one below the other with a divider
// between them, the history as the last group (quieter); nothing below it. At the middle of its height, half over the bar's right edge, a small
// button toggles between wide (icon and text, 232 px) and narrow (icons with a tooltip, 56 px). The choice is remembered; below
// 1000 px of window width the bar is narrow whatever the choice (it is not overwritten). The settings are not here: their button
// is in the slim bar (SlimBar.vue).
import { computed, onMounted, onUnmounted, ref } from "vue";
import { RouterLink, useRoute } from "vue-router";
import Icon from "../../../adminapp/src/components/Icon.vue";
import Tooltip from "../../../adminapp/src/components/Tooltip.vue";
import { capabilities } from "../capabilities";
import { t } from "../i18n";
import { parseSideMode, sideGroups, sideModeFor, SIDE_NARROW_BELOW, type SideMode } from "../navigation";

const STORE_KEY = "qm.sideMode";
const route = useRoute();

const groups = computed(() => sideGroups(capabilities.value));

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
    <nav class="nav">
      <template v-for="(group, i) in groups" :key="i">
        <div v-if="i > 0" class="sep" />
        <Tooltip v-for="tab in group" :key="tab.to" side="right" :text="tab.disabled ? t('trade.noUex') : narrow ? t(tab.label) : null">
          <!-- Not usable (buy/sell without UEX data): in its place, greyed out, the tooltip says why -->
          <span v-if="tab.disabled" class="item disabled" :class="{ narrow }" aria-disabled="true" :aria-label="t(tab.label)">
            <Icon :name="tab.icon" :size="16" />
            <span v-if="!narrow">{{ t(tab.label) }}</span>
          </span>
          <RouterLink v-else :to="tab.to" class="item" :class="{ narrow, secondary: tab.secondary, active: route.path === tab.to }" :aria-label="t(tab.label)">
            <Icon :name="tab.icon" :size="tab.secondary ? 15 : 16" />
            <span v-if="!narrow">{{ t(tab.label) }}</span>
          </RouterLink>
        </Tooltip>
      </template>
    </nav>

    <!-- Centred on the bar's right edge, above the content -->
    <div class="toggle-wrap">
      <Tooltip side="right" :text="t(narrow ? 'nav.expand' : 'nav.collapse')">
        <button type="button" class="toggle" :disabled="forced" :aria-label="t(narrow ? 'nav.expand' : 'nav.collapse')" @click="toggle">
          <Icon :name="narrow ? 'chevron-right' : 'chevron-left'" :size="14" />
        </button>
      </Tooltip>
    </div>
  </aside>
</template>

<style scoped>
/* From the window's top to the footer (App.vue's layout stretches it; only the content beside it scrolls). Above the slim bar
   (z 30), so the toggle that reaches over the edge stays on top */
.side {
  position: relative;
  z-index: 31;
  width: 232px;
  flex-shrink: 0;
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  padding: 8px;
  background: var(--bg-surface);
  border-right: 1px solid var(--border-dim);
  user-select: none;
}

.side.narrow {
  width: 56px;
}

.nav {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.sep {
  height: 1px;
  margin: 6px 4px;
  background: var(--border-dim);
}

/* 20 px wide, 24 high: the middle of it is the border line (the bar's width is the border box: 232 or 56) */
/* At the middle of the bar's height */
.toggle-wrap {
  position: absolute;
  top: 50%;
  right: -11px;
  transform: translateY(-50%);
}

.toggle {
  width: 20px;
  height: 24px;
  padding: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  /* Quiet until pointed at: the bar's own ground, a dim frame, a dim chevron */
  border: 1px solid color-mix(in srgb, var(--border-dim) 55%, transparent);
  border-radius: var(--radius-control);
  background: var(--bg-surface);
  color: var(--text-3);
  cursor: pointer;
}

.toggle:hover:not(:disabled) {
  border-color: var(--accent);
  color: var(--accent);
}

.toggle:disabled {
  opacity: 0.5;
  cursor: default;
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

.item.disabled,
.item.disabled:hover {
  color: var(--text-3);
  opacity: 0.6;
  cursor: default;
}

.item.active,
.item.active:hover {
  background: var(--accent);
  color: var(--accent-text);
}
</style>
