<script setup lang="ts">
// The scan overlay's page (Rust: overlay.rs; the main window's side: overlay.ts): the active tab's
// panel as a fixed-size rounded tile on a transparent window, read-only (the window ignores the
// mouse): title with its tags (the inventory's detected kinds, else the state), the newest rows,
// "+n more". Everything comes as text in the UI
// language from the main window ("overlay-view", on every change and when this page asks).
import { onMounted, ref } from "vue";
import { emit, listen } from "@tauri-apps/api/event";
import Icon from "../../adminapp/src/components/Icon.vue";
import type { OverlayView } from "./overlay";

const view = ref<OverlayView | null>(null);

onMounted(async () => {
  await listen<OverlayView>("overlay-view", (e) => (view.value = e.payload));
  await emit("overlay-request");
});
</script>

<template>
  <section v-if="view" class="panel tile">
    <div class="head">
      <span class="head-title">{{ view.title }} <span class="count">{{ view.count }}</span></span>
      <span v-for="(x, i) in view.tags" :key="i" class="tag" :class="[x.cls, { icon: !x.text }]"><Icon :name="x.icon" :size="12" /> {{ x.text }}</span>
    </div>
    <div v-if="!view.rows.length" class="empty">{{ view.empty }}</div>
    <div v-for="(r, i) in view.rows" :key="i" class="row">
      <span class="tag" :class="[r.cls, { icon: r.icon }]"><Icon v-if="r.icon" :name="r.icon" :size="12" />{{ r.tag }}</span>
      <span class="name">{{ r.name }}<span v-if="r.detail" class="detail"> · {{ r.detail }}</span></span>
      <span v-for="(c, j) in r.cols" :key="j" class="num">{{ c }}</span>
    </div>
    <div v-if="view.more" class="more">{{ view.more }}</div>
  </section>
</template>

<style>
/* Only the tile shows: the window itself is transparent */
html,
body,
#app {
  height: 100%;
  margin: 0;
  overflow: hidden;
  background: transparent;
}
</style>

<style scoped>
/* Slightly see-through: the game stays visible behind the tile */
.tile {
  height: 100%;
  box-sizing: border-box;
  border: 1px solid var(--border-dim);
  background: color-mix(in srgb, var(--bg-surface) 82%, transparent);
  padding-bottom: 8px;
}

.head {
  flex-wrap: nowrap;
  padding: 8px 12px;
}

.head-title {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* The row count after the title, kept quiet */
.count {
  font-weight: 400;
  font-size: 12px;
  color: var(--text-3);
}

.empty {
  padding: 16px 12px;
  font-size: 12px;
  color: var(--text-2);
}

/* Like the main window's compact rows: tag, name with its detail, right-aligned columns */
.row {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 26px;
  padding: 2px 12px;
  font-size: 12px;
  color: var(--text-2);
}

.row + .row {
  border-top: 1px solid var(--border-dim);
}

.row .tag {
  flex-shrink: 0;
}

/* An icon-only badge (the inventory's kinds) */
.tag.icon {
  padding: 0 5px;
}

.name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text);
}

.detail {
  color: var(--text-2);
}

.num {
  flex-shrink: 0;
  text-align: right;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

.more {
  margin-top: auto;
  padding: 4px 12px 6px;
  font-size: 11px;
  color: var(--text-2);
}
</style>
