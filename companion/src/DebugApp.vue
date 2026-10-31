<script setup lang="ts">
// The debug window (opened from the settings; remote troubleshooting) in three tabs: General
// (DebugGeneral.vue: app, folders, catalog, language pack), the OCR scan (DebugScan.vue: the last read with
// its frame, the detections of both scans, a recording) and Game.log (DebugGamelog.vue: the file, the
// blueprint unlocks and the location lines as the main window matched them, a static export). All stay
// mounted (v-show): their listeners and the last read survive a tab switch. The styles below are shared
// by all (not scoped).
import { onMounted, ref } from "vue";
import { listen } from "@tauri-apps/api/event";
import { getConfig } from "./backend";
import { applyLangSetting, t } from "./i18n";
import { errorText, toast } from "./toasts";
import DebugGamelog from "./components/DebugGamelog.vue";
import DebugGeneral from "./components/DebugGeneral.vue";
import DebugScan from "./components/DebugScan.vue";
import Toasts from "./components/Toasts.vue";
import ClipTip from "./components/ClipTip.vue";

const tab = ref<"general" | "scan" | "log">("scan");

const applyLanguage = async () => applyLangSetting((await getConfig()).language);

onMounted(async () => {
  try {
    await applyLanguage();
    await listen("config-changed", () => void applyLanguage().catch(() => undefined));
  } catch (e) {
    toast(errorText(e), "error");
  }
});
</script>

<template>
  <div class="debug">
    <nav class="tabs">
      <button type="button" class="tab" :class="{ active: tab === 'general' }" @click="tab = 'general'">{{ t("debug.tab.general") }}</button>
      <button type="button" class="tab" :class="{ active: tab === 'scan' }" @click="tab = 'scan'">{{ t("debug.tab.scan") }}</button>
      <button type="button" class="tab" :class="{ active: tab === 'log' }" @click="tab = 'log'">{{ t("debug.tab.log") }}</button>
    </nav>
    <DebugGeneral v-show="tab === 'general'" />
    <DebugScan v-show="tab === 'scan'" />
    <DebugGamelog v-show="tab === 'log'" />
    <Toasts />
    <ClipTip />
  </div>
</template>

<style>
.debug {
  display: flex;
  flex-direction: column;
  height: 100vh;
  font-size: 12px;
  color: var(--text-2);
}

.debug .spacer {
  flex: 1;
}

/* The tab bar at the top (the window's own title names it), like the web app's */
.debug .tabs {
  display: flex;
  gap: 4px;
  flex-shrink: 0;
  padding: 6px 16px 0;
  background: var(--bg-surface);
  border-bottom: 1px solid var(--border-dim);
}

.debug .tab {
  padding: 6px 12px;
  border: none;
  border-bottom: 2px solid transparent;
  background: none;
  color: var(--text-2);
  font: inherit;
  font-weight: 600;
  cursor: pointer;
}

.debug .tab.active {
  color: var(--text);
  border-bottom-color: var(--accent);
}

/* One tab's content: its row of switches and actions, then what scrolls */
.debug .pane {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

.debug .sub {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 44px;
  flex-shrink: 0;
  padding: 0 16px;
  border-bottom: 1px solid var(--border-dim);
}

.debug .sub .chip {
  height: 22px;
  padding: 0 8px;
  font-size: 11px;
}

/* Two or more views of one tab, as one control */
.debug .seg {
  display: flex;
  border: 1px solid var(--border);
  border-radius: var(--radius-control);
  overflow: hidden;
}

.debug .seg button {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 26px;
  padding: 0 10px;
  border: none;
  background: none;
  color: var(--text-2);
  font: inherit;
  font-weight: 600;
  cursor: pointer;
}

.debug .seg button.active {
  background: var(--bg-surface-2);
  color: var(--text);
}

.debug .cnt {
  font-family: var(--font-mono);
  font-weight: 400;
  color: var(--text-3);
}

.debug .content {
  flex: 1;
  min-height: 0;
  overflow: auto;
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 12px 16px 16px;
}

/* The read's key figures in one row */
.debug .strip {
  display: grid;
  grid-auto-columns: minmax(0, 1fr);
  grid-auto-flow: column;
  flex-shrink: 0;
  border: 1px solid var(--border-dim);
  border-radius: var(--radius-panel);
  background: var(--bg-surface);
}

.debug .strip > div {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
  padding: 6px 10px;
  border-left: 1px solid var(--border-dim);
}

.debug .strip > div:first-child {
  border-left: none;
}

.debug .strip .k {
  font-size: 10px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--text-3);
}

.debug .strip .v {
  font-family: var(--font-mono);
  font-size: 13px;
  color: var(--text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.debug .two {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
  align-items: start;
}

.debug .panel {
  flex-shrink: 0;
  border: 1px solid var(--border-dim);
  border-radius: var(--radius-panel);
  background: var(--bg-surface);
  overflow: hidden;
}

.debug .ph {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 30px;
  padding: 0 10px;
  border-bottom: 1px solid var(--border-dim);
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.06em;
}

.debug .ph .chip,
.debug .ph .tag {
  text-transform: none;
  letter-spacing: 0;
}

.debug .ph .chip {
  height: 20px;
  padding: 0 8px;
  font-size: 11px;
}

.debug .ph .right {
  margin-left: auto;
  font-family: var(--font-mono);
  font-weight: 400;
  text-transform: none;
  letter-spacing: 0;
  color: var(--text);
}

/* A collapsible panel: its head is the summary */
.debug details.panel > summary {
  cursor: pointer;
  list-style: none;
}

.debug details.panel > summary::-webkit-details-marker {
  display: none;
}

.debug details.panel:not([open]) > summary {
  border-bottom: none;
}

.debug details.panel .chev {
  transition: transform 0.15s;
}

.debug details.panel[open] .chev {
  transform: rotate(90deg);
}

/* Key and value pairs, two (or four) columns; the last row's line hides below the panel's edge */
.debug .kv {
  display: grid;
  grid-template-columns: 120px minmax(0, 1fr);
  margin-bottom: -1px;
}

.debug .kv.wide {
  grid-template-columns: 120px minmax(0, 1fr) 120px minmax(0, 1fr);
}

.debug .kv > span {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  height: 24px;
  padding: 0 10px;
  border-bottom: 1px solid var(--border-dim);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.debug .kv > .kk {
  color: var(--text-3);
}

.debug .kv > .vv {
  font-family: var(--font-mono);
  color: var(--text);
}

.debug .kv > .span3 {
  grid-column: span 3;
}

.debug table {
  width: 100%;
  border-collapse: collapse;
  table-layout: fixed;
}

.debug th {
  height: 24px;
  padding: 0 10px;
  text-align: left;
  font-size: 10px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--text-3);
  border-bottom: 1px solid var(--border-dim);
}

.debug td {
  height: 22px;
  padding: 0 10px;
  border-top: 1px solid var(--border-dim);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.debug tbody tr:first-child td {
  border-top: none;
}

.debug tbody tr:nth-child(even) td {
  background: color-mix(in srgb, var(--bg-surface-2) 40%, transparent);
}

.debug tr.hl td {
  background: color-mix(in srgb, var(--accent) 16%, transparent);
  color: var(--text);
}

.debug .num {
  text-align: right;
  font-family: var(--font-mono);
}

.debug th.num {
  font-family: inherit;
}

.debug .mono {
  font-family: var(--font-mono);
}

.debug .white {
  color: var(--text);
}

.debug .warn-text {
  color: var(--warn);
}

.debug .sub-h {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 26px;
  padding: 0 10px;
  border-top: 1px solid var(--border-dim);
  border-bottom: 1px solid var(--border-dim);
  background: var(--bg-base);
  font-size: 10px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--text-3);
}

.debug .panel .empty-line {
  padding: 12px 10px;
}
</style>
