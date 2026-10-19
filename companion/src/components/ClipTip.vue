<script setup lang="ts">
// A text clipped at its end ("…": text-overflow ellipsis and wider than its box) shows its full text in
// a bubble like Tooltip's after a moment of hovering: one per window (App.vue, DebugApp.vue), for every
// table and line without touching them. Elements with a tooltip of their own (a title, a Tooltip
// anchor) and inputs are left alone.
import { nextTick, onMounted, onUnmounted, ref } from "vue";

const DELAY_MS = 450;
const MARGIN = 8;
const GAP = 6;
// How far up from the hovered node a clipped box is looked for (a name's detail span inside its cell)
const DEPTH = 4;

const text = ref<string | null>(null);
const bubble = ref<HTMLElement | null>(null);
const pos = ref<{ left: number; top: number } | null>(null);
let current: HTMLElement | null = null;
let timer: ReturnType<typeof setTimeout> | undefined;

/** The clipped box at or above a hovered node, null when there is none. */
function clippedAt(node: EventTarget | null): HTMLElement | null {
  let el = node instanceof HTMLElement ? node : null;
  if (!el || el.closest("[title], .tip-anchor, input, textarea")) return null;
  for (let i = 0; el && i < DEPTH; i++, el = el.parentElement) {
    if (getComputedStyle(el).textOverflow === "ellipsis" && el.scrollWidth > el.clientWidth) return el;
  }
  return null;
}

function hide() {
  clearTimeout(timer);
  current = null;
  text.value = null;
  pos.value = null;
}

async function show(el: HTMLElement) {
  const full = el.textContent?.trim();
  if (!full || current !== el) return;
  text.value = full;
  pos.value = null;
  await nextTick();
  const a = el.getBoundingClientRect();
  const b = bubble.value?.getBoundingClientRect();
  if (!b || current !== el) return;
  const left = Math.min(Math.max(a.left + a.width / 2 - b.width / 2, MARGIN), window.innerWidth - b.width - MARGIN);
  const above = a.top - GAP - b.height;
  const top = above >= MARGIN ? above : Math.min(a.bottom + GAP, window.innerHeight - b.height - MARGIN);
  pos.value = { left: Math.max(left, MARGIN), top: Math.max(top, MARGIN) };
}

function onOver(e: MouseEvent) {
  const el = clippedAt(e.target);
  if (el === current) return;
  hide();
  if (!el) return;
  current = el;
  timer = setTimeout(() => void show(el), DELAY_MS);
}

function onOut(e: MouseEvent) {
  if (current && !(e.relatedTarget instanceof Node && current.contains(e.relatedTarget))) hide();
}

onMounted(() => {
  document.addEventListener("mouseover", onOver);
  document.addEventListener("mouseout", onOut);
  document.addEventListener("mousedown", hide, true);
  document.addEventListener("scroll", hide, true);
});
onUnmounted(() => {
  hide();
  document.removeEventListener("mouseover", onOver);
  document.removeEventListener("mouseout", onOut);
  document.removeEventListener("mousedown", hide, true);
  document.removeEventListener("scroll", hide, true);
});
</script>

<template>
  <Teleport to="body">
    <!-- Rendered hidden first to measure it, then placed -->
    <div
      v-if="text"
      ref="bubble"
      class="clip-tip"
      role="tooltip"
      :style="pos ? { left: `${pos.left}px`, top: `${pos.top}px` } : { left: '0px', top: '0px', visibility: 'hidden' }"
    >
      {{ text }}
    </div>
  </Teleport>
</template>

<style scoped>
/* Tooltip.vue's bubble */
.clip-tip {
  position: fixed;
  z-index: 100;
  max-width: min(360px, calc(100vw - 16px));
  padding: 8px 10px;
  border-radius: var(--radius-control);
  border: 1px solid var(--border);
  background: var(--bg-surface-3);
  color: var(--text);
  font-family: var(--font-ui);
  font-size: 12px;
  font-weight: 400;
  line-height: 1.4;
  letter-spacing: normal;
  text-transform: none;
  white-space: normal;
  overflow-wrap: anywhere;
  pointer-events: none;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.4);
}
</style>
