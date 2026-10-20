<script setup lang="ts">
// The scan overlay's page (Rust: overlay.rs; the main window's side: overlay.ts): a compact fixed-size
// tile on a transparent window, read-only (the window ignores the mouse): on the right a narrow rail
// with the four modes, each its icon above its count (as wide as "999"; the shown one highlighted; a
// warning instead of the count when its filters are all off or the log is missing); next to it the
// location line (clipped at its end), then the newest rows, 20 px each, as many as fit (more than that:
// the last one fades out). No hint texts: without rows only the location shows.
// Everything comes as text in the UI language from the main window ("overlay-view", on every change
// and when this page asks).
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
  <section v-if="view" class="tile">
    <div class="main">
      <div class="place" :class="{ missing: view.placeMissing }">
        <Icon :name="view.placeMissing ? 'warning' : 'locate'" :size="12" />
        <span>{{ view.place }}</span>
      </div>
      <!-- More rows than fit: the last one fades out -->
      <div class="rows" :class="{ more: view.more }">
        <div v-for="(r, i) in view.rows" :key="i" class="row">
          <span class="tag" :class="[r.cls, { icon: r.icon }]"><Icon v-if="r.icon" :name="r.icon" :size="10" />{{ r.tag }}</span>
          <span class="name">{{ r.name }}<span v-if="r.detail" class="detail"> · {{ r.detail }}</span></span>
          <span v-for="(c, j) in r.cols" :key="j" class="num">{{ c }}</span>
        </div>
      </div>
    </div>
    <div class="rail">
      <span v-for="(x, i) in view.tabs" :key="i" class="mode" :class="{ active: x.active, warn: x.warn }">
        <Icon :name="x.icon" :size="10" />
        <Icon v-if="x.warn" name="warning" :size="10" />
        <span v-else>{{ x.count }}</span>
      </span>
    </div>
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
  display: flex;
  height: 100%;
  box-sizing: border-box;
  overflow: hidden;
  border: 1px solid var(--border-dim);
  border-radius: var(--radius-panel);
  background: color-mix(in srgb, var(--bg-surface) 82%, transparent);
  font-size: 12px;
  line-height: 1.35;
}

/* The location line and the rows below it */
.main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
}

/* The location in the mono face after its icon, clipped only at its end */
.place {
  display: flex;
  align-items: center;
  gap: 5px;
  height: 22px;
  flex-shrink: 0;
  padding: 0 8px;
  border-bottom: 1px solid var(--border-dim);
  font-family: var(--font-mono);
  color: var(--text);
}

.place > svg {
  flex-shrink: 0;
  color: var(--accent);
}

.place > span {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.place.missing,
.place.missing > svg {
  color: var(--warn);
}

/* The modes on the right, top down */
.rail {
  display: flex;
  flex-direction: column;
  gap: 2px;
  flex-shrink: 0;
  padding: 4px 3px;
  border-left: 1px solid var(--border-dim);
}

/* Icon above the count; exactly as wide as three digits ("999") */
.mode {
  display: flex;
  flex-direction: column;
  align-items: center;
  width: 3ch;
  padding: 2px 2px;
  border-radius: var(--radius-control);
  color: var(--text-3);
  font-size: 10px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  line-height: 1.2;
}

.mode.active {
  color: var(--text);
  background: color-mix(in srgb, var(--accent) 22%, transparent);
}

.mode.warn {
  color: var(--warn);
}

.rows {
  flex: 1;
  min-height: 0;
  overflow: hidden;
  padding: 2px 0;
}

.rows.more {
  mask-image: linear-gradient(to bottom, #000 calc(100% - 22px), transparent);
}

/* Tag, name with its detail, right-aligned columns; no lines between */
.row {
  display: flex;
  align-items: center;
  gap: 6px;
  height: 20px;
  padding: 0 8px;
  color: var(--text-2);
}

.row .tag {
  flex-shrink: 0;
  height: 16px;
  padding: 0 4px;
  font-size: 10px;
}

/* An icon-only badge (the inventory's kinds) */
.tag.icon {
  padding: 0 2px;
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
</style>
