<script lang="ts">
// The card open right now. Leaving its anchor closes it a moment later: moving to another anchor of the
// same entry (the thumbnail and the name in two cells of a row) keeps it open instead of closing and
// reopening it.
const HANDOVER_MS = 150;
interface OpenCard { key: string; close: () => void; timer?: ReturnType<typeof setTimeout> }
let open: OpenCard | null = null;
</script>

<script setup lang="ts">
// Game data for a blueprint or a material as a card on hover: wraps the name, loads the card on
// first use and shows it only once it is there (teleported, placed like the admin's Tooltip: above
// the name, below it when there is no room). It overlays the page, nothing moves. The card's content: InfoCard.
import { computed, nextTick, onUnmounted, ref } from "vue";
import type { BlueprintInfo, MaterialInfo } from "../../../src/webapp/api-types";
import { blueprintThumb, materialThumb, preloadThumb } from "../thumbs";
import InfoCard, { loadInfo } from "./InfoCard.vue";

const props = defineProps<{ kind: "blueprint" | "material"; uuid: string }>();

const DELAY_MS = 350;
const MARGIN = 8;
const GAP = 8;

const anchor = ref<HTMLElement | null>(null);
const card = ref<HTMLElement | null>(null);
const info = ref<BlueprintInfo | MaterialInfo | null>(null);
const pos = ref<{ left: number; top: number } | null>(null);
let timer: ReturnType<typeof setTimeout> | undefined;
let hovering = false;

const thumb = computed(() => (props.kind === "blueprint" ? blueprintThumb(props.uuid) : materialThumb(props.uuid)));

const entryKey = () => `${props.kind}:${props.uuid}`;
// This instance's own open card (an entry of `open`)
let mine: OpenCard | null = null;

function enter() {
  hovering = true;
  // The same entry's card is still open (its anchor just left): it stays, this anchor takes it over
  if (open?.key === entryKey()) {
    clearTimeout(open.timer);
    open.timer = undefined;
    return;
  }
  // Loading starts with the hover: the image is there when the card opens
  preloadThumb("l", thumb.value);
  clearTimeout(timer);
  timer = setTimeout(async () => {
    try {
      const loaded = await loadInfo(props.kind, props.uuid);
      if (!hovering) return;
      if (open && open !== mine) open.close();
      info.value = loaded;
      pos.value = null;
      mine = { key: entryKey(), close: closeMine };
      open = mine;
      await nextTick();
      place();
    } catch {
      // No card then; the name stays as it is
    }
  }, DELAY_MS);
}

function closeMine() {
  info.value = null;
  if (mine) clearTimeout(mine.timer);
  if (open === mine) open = null;
  mine = null;
}

function leave() {
  hovering = false;
  clearTimeout(timer);
  const shown = open;
  if (shown?.key === entryKey()) {
    clearTimeout(shown.timer);
    shown.timer = setTimeout(() => shown.close(), HANDOVER_MS);
  } else if (mine) {
    closeMine();
  }
}

function place() {
  const a = anchor.value?.getBoundingClientRect();
  const b = card.value?.getBoundingClientRect();
  if (!a || !b) return;
  const left = Math.min(Math.max(a.left, MARGIN), window.innerWidth - b.width - MARGIN);
  const above = a.top - GAP - b.height;
  const top = above >= MARGIN ? above : Math.min(a.bottom + GAP, window.innerHeight - b.height - MARGIN);
  pos.value = { left: Math.max(left, MARGIN), top: Math.max(top, MARGIN) };
}

onUnmounted(() => {
  clearTimeout(timer);
  if (mine) closeMine();
});
</script>

<template>
  <span ref="anchor" class="info-anchor" @mouseenter="enter" @mouseleave="leave" @focusin="enter" @focusout="leave"><slot /></span>
  <Teleport to="body">
    <div
      v-if="info"
      ref="card"
      class="info-pop"
      :class="{ 'with-thumb': thumb.hash }"
      role="tooltip"
      :style="pos ? { left: `${pos.left}px`, top: `${pos.top}px` } : { left: '0px', top: '0px', visibility: 'hidden' }"
    >
      <InfoCard :kind="kind" :uuid="uuid" :info="info" />
    </div>
  </Teleport>
</template>

<style scoped>
.info-anchor {
  cursor: help;
}

.info-pop {
  position: fixed;
  z-index: 70;
  width: max-content;
  max-width: min(380px, calc(100vw - 16px));
  padding: 12px 14px;
  border: 1px solid var(--border);
  border-radius: var(--radius-panel);
  background: var(--bg-surface);
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.45);
  pointer-events: none;
}

/* The thumbnail left of the text: the text keeps its width */
.info-pop.with-thumb {
  max-width: min(522px, calc(100vw - 16px));
}

/* Narrow screens: the thumbnail above the text */
@media (max-width: 560px) {
  .info-pop.with-thumb {
    max-width: min(380px, calc(100vw - 16px));
  }
}
</style>
