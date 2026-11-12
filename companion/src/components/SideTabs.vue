<script setup lang="ts">
// The main window's tabs as a panel at the left edge, like the desktop app's side bar (webapp/src/components/SideNav.vue, copied:
// that one is router based) but below the title bar and the scan row, down to the window's bottom. Two groups with a divider: the
// scan modes (also the scan overlay's modes), then the look-up tabs; a new tab is one more entry in a group. Narrow (56 px): the
// icon with the row count below it, the tab's name in a tooltip; wide (200 px): icon, name, the count at the right. A small button
// half over the panel's right edge toggles the two (always possible); the choice is remembered (default narrow). Wide raises the
// window's minimum width by the difference and widens a narrower window to it, so the tables keep their width.
import { computed, onMounted, ref } from "vue";
import { getCurrentWindow, LogicalSize } from "@tauri-apps/api/window";
import Icon from "../../../adminapp/src/components/Icon.vue";
import Tooltip from "../../../adminapp/src/components/Tooltip.vue";
import { t, type Key } from "../i18n";
import { pickTab, tab, TAB_ICONS, tabCounts, type Tab } from "../overlay";
import { minWidthFor, parseSideMode, type SideMode } from "../sideTabs";
import { toastError } from "../toasts";

interface Entry {
  id: Tab;
  label: Key;
}

// The scan modes in the order the mode hotkey steps through them, then the look-up tabs
const GROUPS: Entry[][] = [
  [
    { id: "comps", label: "comps.title" },
    { id: "stock", label: "stock.title" },
    { id: "refinery", label: "refinery.title" },
  ],
  [{ id: "unlocks", label: "unlocks.title" }],
];

const STORE_KEY = "qm.companion.sideMode";

function stored(): SideMode {
  try {
    return parseSideMode(localStorage.getItem(STORE_KEY));
  } catch {
    return "narrow";
  }
}

const choice = ref<SideMode>(stored());
const narrow = computed(() => choice.value === "narrow");

// The window's minimum height, as in tauri.conf.json (setMinSize wants both)
const MIN_HEIGHT = 780;
const win = getCurrentWindow();

// Sets the window's minimum width for the mode; wide: a narrower window is widened to it (position and height stay). Collapsing
// only lowers the minimum. Runs once mounted (after the window-state plugin restored the stored size) and on every toggle.
async function fitWindow(mode: SideMode) {
  const min = minWidthFor(mode);
  await win.setMinSize(new LogicalSize(min, MIN_HEIGHT));
  if (mode !== "wide") return;
  const size = (await win.innerSize()).toLogical(await win.scaleFactor());
  if (size.width < min) await win.setSize(new LogicalSize(min, size.height));
}
const fit = () => void fitWindow(choice.value).catch(toastError);

function toggle() {
  choice.value = choice.value === "wide" ? "narrow" : "wide";
  try {
    localStorage.setItem(STORE_KEY, choice.value);
  } catch { /* the choice holds for this run */ }
  fit();
}

onMounted(fit);
</script>

<template>
  <aside class="side" :class="{ narrow }">
    <nav class="nav">
      <template v-for="(group, i) in GROUPS" :key="i">
        <div v-if="i > 0" class="sep" />
        <Tooltip v-for="x in group" :key="x.id" side="right" :text="narrow ? t(x.label) : null">
          <button type="button" class="item" :class="{ narrow, active: tab === x.id }" :aria-label="t(x.label)" @click="pickTab(x.id)">
            <Icon :name="TAB_ICONS[x.id]" :size="20" />
            <span v-if="!narrow" class="name">{{ t(x.label) }}</span>
            <span class="count">{{ tabCounts[x.id] }}</span>
          </button>
        </Tooltip>
      </template>
    </nav>

    <!-- Centred on the panel's right edge, above the main area -->
    <div class="toggle-wrap">
      <Tooltip side="right" :text="t(narrow ? 'side.expand' : 'side.collapse')">
        <button type="button" class="toggle" :aria-label="t(narrow ? 'side.expand' : 'side.collapse')" @click="toggle">
          <Icon :name="narrow ? 'chevron-right' : 'chevron-left'" :size="14" />
        </button>
      </Tooltip>
    </div>
  </aside>
</template>

<style scoped>
/* From below the scan row to the window's bottom (App.vue's layout stretches it; only the main area beside it scrolls). Above the
   main area, so the toggle that reaches over the edge stays on top */
.side {
  position: relative;
  z-index: 31;
  width: 200px;
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

/* 20 px wide, 24 high: the middle of it is the border line (the panel's width is the border box: 200 or 56) */
/* At the middle of the panel's height */
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
  /* Quiet until pointed at: the panel's own ground, a dim frame, a dim chevron */
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
  cursor: pointer;
}

.item:hover {
  color: var(--text);
}

.item.active,
.item.active:hover {
  background: var(--accent);
  color: var(--accent-text);
}

.name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  text-align: left;
}

/* The row count: quiet, tabular, in a fixed room (room for "999"), so it never changes the entry's size */
.count {
  flex-shrink: 0;
  min-width: 3ch;
  text-align: right;
  font-weight: 400;
  font-size: 15px;
  font-variant-numeric: tabular-nums;
  color: var(--text-3);
}

.item.active .count {
  color: inherit;
  opacity: 0.8;
}

/* Narrow: the icon over the small count in mono, both centred (the entry is 40 px wide, the same height in every state) */
.item.narrow {
  width: 40px;
  height: 56px;
  flex: none;
  flex-direction: column;
  justify-content: center;
  gap: 3px;
  padding: 0;
}

.item.narrow .count {
  min-width: 0;
  width: 100%;
  text-align: center;
  font-family: var(--font-mono);
  font-size: 14px;
  line-height: 16px;
}
</style>
