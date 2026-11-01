<script setup lang="ts">
// A material's or item's info card as a header band (Kaufen/Verkaufen's pick, a Crafting card's head;
// layout "Kopfband", 2026-11-01): the M thumbnail left, then name with its tags, one line of plain facts
// (item: type · S1 · Grade C · class; resource: group, refined to, from ore, blueprints), the values from
// the head of the game's text in one line, then its prose (one line, all of it on hover); no maker
// (it only takes room). No boxes: nothing in the band looks like an
// input. Right: the caller's `actions` at the top, its `corner` at the bottom. `info` null while it loads:
// the band stands (thumbnail, name, the lines' height), nothing moves when the rest arrives.
import { computed } from "vue";
import type { MaterialInfo } from "../../../src/webapp/api-types";
import type { IconName } from "../../../adminapp/src/components/Icon.vue";
import { t } from "../i18n";
import type { ThumbRef } from "../thumbs";
import { descriptionParts, typeLine } from "./InfoCard.vue";
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
// The text's head values in one line ("Batteriekapazität: 80 Schuss · Schussrate: …"), the prose below them
const desc = computed(() => (props.info ? descriptionParts(props.info) : { head: [], prose: null }));
const headLine = computed(() => desc.value.head.join(" · "));
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
      <div v-if="headLine" class="head-line" :title="desc.head.join('\n')">{{ headLine }}</div>
      <p class="description" :title="desc.prose ?? undefined">{{ desc.prose }}</p>
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

/* The facts after a bullet (the values below set apart by the mono face instead) */
.dot::before {
  content: "•";
  margin-right: 7px;
  color: var(--text-3);
}

/* The values from the head of the game's text: one line, all of them on hover */
/* As much room above as below it (the prose's 6 px) */
.head-line {
  margin-top: 6px;
  font-family: var(--font-mono);
  font-size: 12px;
  color: var(--text-2);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}


/* The game's prose, quiet, a little apart: one line, cut with an ellipsis (all of it on hover) */
.description {
  margin: 6px 0 0;
  max-width: 90ch;
  min-height: 1.45em;
  font-size: 12px;
  line-height: 1.45;
  color: var(--text-3);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
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
