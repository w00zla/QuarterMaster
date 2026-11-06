<script setup lang="ts">
// The scan overlay's page (Rust: overlay.rs; the main window's side: overlay.ts): a compact fixed-size
// tile on a transparent window, read-only (the window ignores the mouse): on the right a narrow rail
// with the four modes, each its icon above its count (as wide as "999"; the shown one highlighted; a
// warning instead of the count when its filters are all off or the log is missing); next to it the
// location line (clipped at its end), then the newest rows, 20 px each, as many as fit (more than that:
// the last one fades out). The display "thumbs" (settings) shows the newest item as a taller top row (its
// thumbnail, the name above its details, the amount right) and the item's small thumbnail after each
// row's tag (if it has one); the refinery keeps rows only. No hint texts: without rows only the location shows.
// Everything comes as text in the UI language from the main window ("overlay-view", on every change
// and when this page asks). A detected item (`flash` counts up) lets the location line light up briefly.
import { computed, onMounted, ref, watch } from "vue";
import { emit, listen } from "@tauri-apps/api/event";
import Icon from "./components/Icon.vue";
import Thumb from "./components/Thumb.vue";
import type { OverlayView } from "./overlay";

const view = ref<OverlayView | null>(null);
// The top row: its details below the name (the columns before the amount too), the amount on the right
const topDetail = computed(() => {
  const top = view.value?.top;
  return top ? [top.detail, ...top.cols.slice(0, -1)].filter(Boolean).join(" · ") : "";
});
const topAmount = computed(() => view.value?.top?.cols.at(-1) ?? null);
// Each change of the count after the first view starts the flash anew (the line is drawn afresh)
const flashes = ref(0);
watch(() => view.value?.flash, (now, before) => {
  if (before !== undefined && now !== before) flashes.value++;
});

onMounted(async () => {
  await listen<OverlayView>("overlay-view", (e) => (view.value = e.payload));
  await emit("overlay-request");
});
</script>

<template>
  <section v-if="view" class="tile">
    <div class="main">
      <div :key="flashes" class="place" :class="{ missing: view.placeMissing, flash: flashes > 0 }">
        <Icon :name="view.placeMissing ? 'warning' : 'locate'" :size="12" />
        <span>{{ view.place }}</span>
      </div>
      <div v-if="view.top" class="top" :class="{ dim: view.top.dim }">
        <Thumb v-if="view.top.thumb" :item="view.top.thumb" size="m" :px="44" />
        <div class="lines">
          <span class="top-name">{{ view.top.name }}</span>
          <span class="top-sub">
            <span v-if="view.top.tag" class="tag" :class="view.top.cls">{{ view.top.tag }}</span>
            <span class="top-detail">{{ topDetail }}</span>
          </span>
        </div>
        <span v-if="topAmount" class="num top-amount">{{ topAmount }}</span>
      </div>
      <!-- More rows than fit: the last one fades out -->
      <div class="rows" :class="{ more: view.more }">
        <div v-for="(r, i) in view.rows" :key="i" class="row" :class="{ dim: r.dim }">
          <span v-if="r.tag" class="tag" :class="r.cls">{{ r.tag }}</span>
          <Thumb v-if="view.display === 'thumbs'" :item="r.thumb" size="s" :px="16" />
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

/* A detected item: the line lights up in the accent colour and fades back */
.place.flash {
  animation: flash 0.7s ease-out;
}

@keyframes flash {
  from {
    background: color-mix(in srgb, var(--accent) 45%, transparent);
  }
  to {
    background: transparent;
  }
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

/* The display "thumbs": the newest item, two lines with larger text next to its thumbnail */
.top {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 60px;
  flex-shrink: 0;
  padding: 0 8px;
  color: var(--text-2);
}

.lines {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.top-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 14px;
  color: var(--text);
}

.top-sub {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  font-size: 12px;
}

.top-detail {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.top .tag {
  flex-shrink: 0;
  height: 16px;
  padding: 0 4px;
  font-size: 10px;
}

.top-amount {
  font-size: 14px;
  color: var(--text);
}

.top.dim,
.top.dim .top-name,
.top.dim .top-amount {
  color: var(--text-3);
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

/* Registered or in stock already: dimmed like in the panel */
.row.dim,
.row.dim .name,
.row.dim .detail {
  color: var(--text-3);
}

.num {
  flex-shrink: 0;
  text-align: right;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
</style>
