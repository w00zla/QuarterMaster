<script setup lang="ts">
// Wraps any content and shows a text bubble on hover/focus, in the app's look. The
// bubble is teleported to <body> (panels with overflow: hidden do not clip it) and
// kept inside the window: centred above the content, shifted sideways at the edges,
// below it when there is no room above. `mono` for technical values. `side="right"`: right of the
// content, at its middle (the entries of a navigation bar at the left edge).
import { nextTick, ref } from "vue";

const props = defineProps<{ text: string | null | undefined; mono?: boolean; side?: "right" }>();

const MARGIN = 8;
const GAP = 8;

const anchor = ref<HTMLElement | null>(null);
const bubble = ref<HTMLElement | null>(null);
const open = ref(false);
const pos = ref<{ left: number; top: number } | null>(null);

async function show() {
  if (!props.text) return;
  open.value = true;
  pos.value = null;
  await nextTick();
  const a = anchor.value?.getBoundingClientRect();
  const b = bubble.value?.getBoundingClientRect();
  if (!a || !b || !open.value) return;
  // Beside the content (a navigation bar at the left edge): right of it, at its middle; where the window ends, as usual
  if (props.side === "right" && a.right + GAP + b.width <= window.innerWidth - MARGIN) {
    const middle = a.top + a.height / 2 - b.height / 2;
    pos.value = { left: a.right + GAP, top: Math.min(Math.max(middle, MARGIN), window.innerHeight - b.height - MARGIN) };
    return;
  }
  const left = Math.min(Math.max(a.left + a.width / 2 - b.width / 2, MARGIN), window.innerWidth - b.width - MARGIN);
  const above = a.top - GAP - b.height;
  const top = above >= MARGIN ? above : Math.min(a.bottom + GAP, window.innerHeight - b.height - MARGIN);
  pos.value = { left: Math.max(left, MARGIN), top: Math.max(top, MARGIN) };
}

function hide() {
  open.value = false;
  pos.value = null;
}
</script>

<template>
  <span ref="anchor" class="tip-anchor" @mouseenter="show" @mouseleave="hide" @focusin="show" @focusout="hide"><slot /></span>
  <Teleport to="body">
    <!-- Rendered hidden first to measure it, then placed -->
    <div
      v-if="open"
      ref="bubble"
      class="tip"
      :class="{ mono }"
      role="tooltip"
      :style="pos ? { left: `${pos.left}px`, top: `${pos.top}px` } : { left: '0px', top: '0px', visibility: 'hidden' }"
    >
      {{ text }}
    </div>
  </Teleport>
</template>

<style scoped>
.tip-anchor {
  display: inline-flex;
  align-items: center;
  min-width: 0;
  max-width: 100%;
}

.tip {
  position: fixed;
  z-index: 100;
  max-width: min(320px, calc(100vw - 16px));
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

.tip.mono {
  font-family: var(--font-mono);
}
</style>
