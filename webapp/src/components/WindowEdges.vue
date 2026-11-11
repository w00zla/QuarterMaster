<script setup lang="ts">
// Resize handles for the frameless desktop window: eight invisible strips along the edges and corners (the same as the
// companion's). Without the native frame nothing offers an edge resize, so the strips ask the shell to start one.
import { shell } from "../shell";
import type { ResizeDirection } from "../shellLogic";

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

function start(dir: ResizeDirection, e: MouseEvent) {
  if (e.button !== 0) return;
  e.preventDefault();
  shell.startResize(dir);
}
</script>

<template>
  <!-- A maximized window has no edges to drag -->
  <template v-if="shell.available && !shell.maximized">
    <div v-for="e in EDGES" :key="e.cls" class="edge" :class="e.cls" @mousedown="start(e.dir, $event)" />
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
</style>
