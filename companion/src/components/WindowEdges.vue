<script setup lang="ts">
// Resize handles for the undecorated window: eight invisible strips along
// the edges and corners. Without the native frame the compositor offers no
// edge resize on Linux, so the app asks the window to start one itself.
// `grip`: a small drawn grip in the bottom right corner as a hint (the main
// window's, over its footer's right end); gone with the handles when maximized.
import { onMounted, onUnmounted, ref } from "vue";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { UnlistenFn } from "@tauri-apps/api/event";

// The API only declares this union, it does not export it.
type ResizeDirection = Parameters<ReturnType<typeof getCurrentWindow>["startResizeDragging"]>[0];

defineProps<{ grip?: boolean }>();

const EDGES: { cls: string; dir: ResizeDirection }[] = [
  { cls: "n", dir: "North" },
  { cls: "s", dir: "South" },
  { cls: "e", dir: "East" },
  { cls: "w", dir: "West" },
  { cls: "ne", dir: "NorthEast" },
  { cls: "nw", dir: "NorthWest" },
  { cls: "se", dir: "SouthEast" },
  { cls: "sw", dir: "SouthWest" },
];

const win = getCurrentWindow();
// A maximized window has no edges to drag.
const maximized = ref(false);
let unlisten: UnlistenFn | null = null;

async function refresh() {
  try {
    maximized.value = await win.isMaximized();
  } catch {
    maximized.value = false;
  }
}

function start(dir: ResizeDirection, e: MouseEvent) {
  if (e.button !== 0) return;
  e.preventDefault();
  void win.startResizeDragging(dir);
}

onMounted(async () => {
  await refresh();
  unlisten = await win.onResized(refresh);
});
onUnmounted(() => {
  unlisten?.();
});
</script>

<template>
  <template v-if="!maximized">
    <div v-for="e in EDGES" :key="e.cls" class="edge" :class="e.cls" @mousedown="start(e.dir, $event)">
      <svg v-if="grip && e.cls === 'se'" class="grip" viewBox="0 0 10 10" aria-hidden="true"><path d="M9 3 3 9M9 6 6 9" /></svg>
    </div>
  </template>
</template>

<style scoped>
.edge {
  position: fixed;
  z-index: 1000;
  --t: 6px;
}

.n,
.s {
  left: var(--t);
  right: var(--t);
  height: var(--t);
}

.e,
.w {
  top: var(--t);
  bottom: var(--t);
  width: var(--t);
}

.n {
  top: 0;
  cursor: n-resize;
}

.s {
  bottom: 0;
  cursor: s-resize;
}

.e {
  right: 0;
  cursor: e-resize;
}

.w {
  left: 0;
  cursor: w-resize;
}

.ne,
.nw,
.se,
.sw {
  width: calc(var(--t) * 2);
  height: calc(var(--t) * 2);
}

.ne {
  top: 0;
  right: 0;
  cursor: ne-resize;
}

.nw {
  top: 0;
  left: 0;
  cursor: nw-resize;
}

.se {
  bottom: 0;
  right: 0;
  cursor: se-resize;
}

.sw {
  bottom: 0;
  left: 0;
  cursor: sw-resize;
}

/* Two short diagonal lines in the corner, quiet like the footer's text */
.grip {
  position: absolute;
  right: 2px;
  bottom: 2px;
  width: 10px;
  height: 10px;
  fill: none;
  stroke: var(--text-3);
  stroke-width: 1.2;
  stroke-linecap: round;
  pointer-events: none;
}
</style>
