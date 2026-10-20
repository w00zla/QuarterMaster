<script lang="ts">
import type { BlueprintInfo, MaterialInfo } from "../../../src/webapp/api-types";
// Loaded cards, per language: hovering the same entry again costs nothing
const cache = new Map<string, Promise<BlueprintInfo | MaterialInfo>>();
</script>

<script setup lang="ts">
// Game data for a blueprint or a material as a card on hover: wraps the name, loads the card on
// first use and shows it only once it is there (teleported, placed like the admin's Tooltip: above
// the name, below it when there is no room). It overlays the page, nothing moves.
import { computed, nextTick, onUnmounted, ref } from "vue";
import Icon from "../../../adminapp/src/components/Icon.vue";
import { typeIcon } from "../../../adminapp/src/typeIcons";
import { api } from "../api";
import { materials } from "../catalog";
import { duration, qty } from "../format";
import { lang, t } from "../i18n";

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

function load() {
  const key = `${lang.value}:${props.kind}:${props.uuid}`;
  let found = cache.get(key);
  if (!found) {
    found = api<BlueprintInfo | MaterialInfo>(`/info/${props.kind}/${props.uuid}?lang=${lang.value}`);
    cache.set(key, found);
    found.catch(() => cache.delete(key));
  }
  return found;
}

function enter() {
  hovering = true;
  clearTimeout(timer);
  timer = setTimeout(async () => {
    try {
      const loaded = await load();
      if (!hovering) return;
      info.value = loaded;
      pos.value = null;
      await nextTick();
      place();
    } catch {
      // No card then; the name stays as it is
    }
  }, DELAY_MS);
}

function leave() {
  hovering = false;
  clearTimeout(timer);
  info.value = null;
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

onUnmounted(() => clearTimeout(timer));

const bp = computed(() => (props.kind === "blueprint" ? (info.value as BlueprintInfo | null) : null));
const mat = computed(() => (props.kind === "material" ? (info.value as MaterialInfo | null) : null));

const itemLine = (i: { typeLabel: string | null; subTypeLabel: string | null; size: number | null; gradeLetter: string | null; itemClass: string | null; manufacturer: string | null }) =>
  [i.typeLabel, i.subTypeLabel, i.size !== null ? `S${i.size}` : null, [i.gradeLetter, i.itemClass].filter(Boolean).join(" ") || null, i.manufacturer]
    .filter(Boolean).join(" · ");
</script>

<template>
  <span ref="anchor" class="info-anchor" @mouseenter="enter" @mouseleave="leave" @focusin="enter" @focusout="leave"><slot /></span>
  <Teleport to="body">
    <div
      v-if="info"
      ref="card"
      class="info-card"
      role="tooltip"
      :style="pos ? { left: `${pos.left}px`, top: `${pos.top}px` } : { left: '0px', top: '0px', visibility: 'hidden' }"
    >
      <template v-if="bp">
        <div class="title">
          <Icon :name="bp.type ? typeIcon(bp.type) : 'blueprint'" :size="15" />
          <span>{{ bp.name }}</span>
          <span v-if="bp.isDefault" class="tag accent">{{ t("info.default") }}</span>
          <span v-if="bp.retired" class="tag err">{{ t("bp.retired") }}</span>
        </div>
        <div v-if="itemLine(bp)" class="meta">{{ itemLine(bp) }}</div>
        <dl class="kv">
          <template v-if="bp.category"><dt>{{ t("bp.col.category") }}</dt><dd>{{ bp.category }}</dd></template>
          <template v-if="bp.craftSeconds !== null"><dt>{{ t("info.craftTime") }}</dt><dd>{{ duration(bp.craftSeconds) }}</dd></template>
          <template v-if="bp.requiredSlots < bp.slots.length"><dt>{{ t("info.slots") }}</dt><dd>{{ t("info.slotsOf", { n: bp.requiredSlots, m: bp.slots.length }) }}</dd></template>
        </dl>
        <div v-if="bp.slots.length" class="section">{{ t("info.ingredients") }}</div>
        <ul v-if="bp.slots.length" class="inputs">
          <li v-for="(s, n) in bp.slots" :key="n">
            <span class="slot">{{ s.name ?? t("info.slot", { n: n + 1 }) }}</span>
            <span>
              <template v-for="(i, k) in s.inputs" :key="k">
                <span v-if="k" class="faint"> / </span>{{ i.name }} <span class="dim">{{ qty(i.quantity, i.kind === "resource" ? "SCU" : "pcs") }}</span><span v-if="i.minQuality" class="dim"> · Q≥{{ i.minQuality }}</span>
              </template>
            </span>
          </li>
        </ul>
      </template>

      <template v-else-if="mat">
        <div class="title">
          <Icon :name="mat.kind === 'resource' ? 'resource' : typeIcon(mat.type)" :size="15" />
          <span>{{ mat.name }}</span>
          <span v-if="mat.isOre" class="tag warn">{{ t("info.ore") }}</span>
        </div>
        <div v-if="mat.kind === 'resource' ? mat.group : itemLine(mat)" class="meta">{{ mat.kind === "resource" ? mat.group : itemLine(mat) }}</div>
        <p v-if="mat.description" class="description">{{ mat.description }}</p>
        <dl class="kv">
          <template v-if="mat.refined"><dt>{{ t("info.refinedTo") }}</dt><dd>{{ mat.refined }}</dd></template>
          <template v-if="mat.ores.length"><dt>{{ t("info.fromOre") }}</dt><dd>{{ mat.ores.join(", ") }}</dd></template>
          <!-- Ausrüstung ist nie Zutat eines Bauplans: keine Zeile dafür -->
          <template v-if="!materials.get(uuid)?.component"><dt>{{ t("info.usedIn") }}</dt><dd>{{ t("info.blueprints", { n: mat.usedIn }) }}</dd></template>
        </dl>
      </template>
    </div>
  </Teleport>
</template>

<style scoped>
.info-anchor {
  cursor: help;
}

.info-card {
  position: fixed;
  z-index: 70;
  width: max-content;
  max-width: min(380px, calc(100vw - 16px));
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px 14px;
  border: 1px solid var(--border);
  border-radius: var(--radius-panel);
  background: var(--bg-surface);
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.45);
  font-size: 12px;
  color: var(--text-2);
  pointer-events: none;
}

.title {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 14px;
  font-weight: 600;
  color: var(--text);
}

.meta {
  color: var(--text-2);
}

/* The game's text keeps its line breaks; long ones are cut after a few lines */
.description {
  margin: 0;
  white-space: pre-line;
  line-height: 1.45;
  color: var(--text);
  display: -webkit-box;
  -webkit-line-clamp: 8;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.kv {
  display: grid;
  grid-template-columns: max-content minmax(0, 1fr);
  gap: 3px 12px;
  margin: 0;
}

.kv dt {
  color: var(--text-3);
}

.kv dd {
  margin: 0;
  color: var(--text);
}

.section {
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: var(--text-3);
}

.inputs {
  margin: 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 3px;
  color: var(--text);
}

.inputs li {
  display: grid;
  grid-template-columns: 90px minmax(0, 1fr);
  gap: 10px;
}

.slot {
  color: var(--text-3);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
