<script setup lang="ts">
// A material's or item's info card as a header band (Kaufen/Verkaufen's pick, a Crafting card's head;
// layout "Kopfband", 2026-11-01): the M thumbnail left, then name with its tags, one line of plain facts
// (item: type · S1 · Grade C · class; resource: group, refined to, from ore, blueprints), then the game's
// text as one piece (cut after three lines, all of it on hover); no maker (it only takes room). No boxes:
// nothing in the band looks like an
// input. Right: the caller's `actions` at the top, its `corner` at the bottom. `info` null while it loads:
// the band stands (thumbnail, name, the lines' height), nothing moves when the rest arrives.
import { computed, nextTick, onUnmounted, ref, watch } from "vue";
import type { MaterialInfo } from "../../../src/webapp/api-types";
import type { IconName } from "../../../adminapp/src/components/Icon.vue";
import { t } from "../i18n";
import type { ThumbRef } from "../thumbs";
import { descriptionText, typeLine } from "./InfoCard.vue";
import Thumb from "./Thumb.vue";

const props = defineProps<{
  thumb: ThumbRef;
  icon: IconName;
  info: MaterialInfo | null;
  // The name to show (else the card's); a lead before the facts (e.g. the blueprint category)
  title?: string;
  lead?: string | null;
}>();

const facts = computed(() => {
  const i = props.info;
  const own = !i ? [] : i.kind === "resource"
    ? [
        i.group,
        i.refined ? `${t("info.refinedTo")} ${i.refined}` : null,
        i.ores.length ? `${t("info.fromOre")} ${i.ores.join(", ")}` : null,
        i.usedIn ? `${t("info.usedIn")} ${t("info.blueprints", { n: i.usedIn })}` : null,
      ]
    : [typeLine(i) || null, i.size !== null ? `S${i.size}` : null, i.gradeLetter ? t("info.grade", { grade: i.gradeLetter }) : null, i.itemClass];
  return [props.lead, ...own].filter(Boolean).join(" · ");
});
const description = computed(() => (props.info ? descriptionText(props.info) : null));

// Cut (more than its three lines): then the whole text as the tooltip and the help cursor, like the names with
// an info card; measured again when the text or the tile's width changes
const descEl = ref<HTMLElement | null>(null);
const cut = ref(false);
const measure = () => { const el = descEl.value; cut.value = !!el && el.scrollHeight > el.clientHeight + 1; };
const resized = new ResizeObserver(measure);
watch(descEl, (el, old) => { if (old) resized.unobserve(old); if (el) resized.observe(el); });
watch(description, () => void nextTick(measure), { immediate: true });
onUnmounted(() => resized.disconnect());
</script>

<template>
  <div class="info-tile">
    <Thumb v-bind="thumb" size="m" :px="96" :icon="icon" :icon-size="44" class="tile-thumb" />
    <div class="tile-main">
      <div class="tile-title">
        <span class="name">{{ title ?? info?.name }}</span>
        <span v-if="info?.isOre" class="tag warn">{{ t("info.ore") }}</span>
        <slot name="tags" />
      </div>
      <div class="facts" :class="{ dot: facts }">{{ facts }}</div>
      <p ref="descEl" class="description" :class="{ cut }" :title="cut ? description ?? undefined : undefined">{{ description }}</p>
    </div>
    <div v-if="$slots.actions || $slots.corner" class="tile-side">
      <div class="side-top"><slot name="actions" /></div>
      <div class="side-bottom"><slot name="corner" /></div>
    </div>
  </div>
</template>

<style scoped>
/* Thumbnail, text, the caller's controls; at least as tall as the thumbnail, so nothing moves while it loads */
.info-tile {
  display: grid;
  grid-template-columns: 96px minmax(0, 1fr) auto;
  gap: 18px;
  align-items: start;
  min-height: 96px;
}

.tile-main {
  display: flex;
  flex-direction: column;
  gap: 3px;
  min-width: 0;
}

.tile-title {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  min-height: 26px;
}

.name {
  min-width: 0;
  font-size: 18px;
  font-weight: 600;
  color: var(--text);
  overflow-wrap: anywhere;
}

/* The facts as plain text; the line keeps its height while the card loads */
.facts {
  min-height: 18px;
  font-size: 13px;
  color: var(--text-2);
}

/* The facts after a bullet */
.dot::before {
  content: "•";
  margin-right: 7px;
  color: var(--text-3);
}

/* The game's text, quiet, a little apart: three lines at most, cut with an ellipsis (all of it on hover) */
.description {
  margin: 6px 0 0;
  max-width: 90ch;
  min-height: 1.45em;
  white-space: pre-line;
  font-size: 12px;
  line-height: 1.45;
  color: var(--text-3);
  display: -webkit-box;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

/* Cut: the whole text on hover, the cursor says so (as on the names with an info card) */
.description.cut {
  cursor: help;
}

/* The caller's controls: the actions at the top right, the corner at the bottom right */
.tile-side {
  display: flex;
  flex-direction: column;
  justify-content: space-between;
  align-items: flex-end;
  align-self: stretch;
  gap: 8px;
}

.side-top,
.side-bottom {
  display: flex;
  align-items: center;
  gap: 8px;
}

/* Phones: a smaller thumbnail, the controls below the text */
@media (max-width: 560px) {
  .info-tile {
    grid-template-columns: 72px minmax(0, 1fr);
    gap: 12px;
    min-height: 72px;
  }

  .tile-thumb {
    width: 72px !important;
    height: 72px !important;
  }

  .tile-thumb :deep(img) {
    width: 72px;
    height: 72px;
  }

  .tile-side {
    grid-column: 1 / -1;
    flex-direction: row;
    align-items: center;
  }
}
</style>
