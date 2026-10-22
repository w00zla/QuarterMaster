<script setup lang="ts">
// Actions per day, stacked by source (bot at the bottom, then web app, companion), to scale from 0 to the
// busiest day; grid lines and labels only up to that day. Hovering a day shows its counts. Legend below with
// the totals. The source colors are this chart's own (not the ok/warn/err ones).
import { computed, onMounted, onUnmounted, ref } from "vue";
import type { ActivitySource, DaySources } from "../../../src/adminapp/api-types";
import { SOURCE_LABEL, dayLabel } from "../activity";

const props = withDefaults(defineProps<{ days: DaySources[]; height?: number }>(), { height: 180 });

const SOURCES: ActivitySource[] = ["bot", "webapp", "companion"];
const PAD = { left: 30, right: 4, top: 8, bottom: 20 };

const root = ref<HTMLElement | null>(null);
const width = ref(600);
let observer: ResizeObserver | null = null;
onMounted(() => {
  observer = new ResizeObserver(([e]) => (width.value = Math.max(120, Math.floor(e!.contentRect.width))));
  if (root.value) observer.observe(root.value);
});
onUnmounted(() => observer?.disconnect());

const plotW = computed(() => width.value - PAD.left - PAD.right);
const plotH = computed(() => props.height - PAD.top - PAD.bottom);
const totalOf = (d: DaySources) => d.bot + d.webapp + d.companion;
const max = computed(() => Math.max(0, ...props.days.map(totalOf)));
const scale = computed(() => Math.max(max.value, 1));
const yOf = (v: number) => PAD.top + plotH.value - (v / scale.value) * plotH.value;

// Grid steps of 1, 2 or 5 × 10^n, at most 4 lines, none above the busiest day
const ticks = computed(() => {
  if (!max.value) return [0];
  const raw = max.value / 4;
  const pow = 10 ** Math.floor(Math.log10(Math.max(raw, 1)));
  const step = [1, 2, 5, 10].map((m) => m * pow).find((s) => s >= raw) ?? pow * 10;
  const out: number[] = [];
  for (let v = 0; v <= max.value; v += step) out.push(v);
  return out;
});

const slot = computed(() => plotW.value / Math.max(props.days.length, 1));
const barW = computed(() => Math.max(1, Math.min(24, slot.value * 0.7)));
const xOf = (i: number) => PAD.left + i * slot.value + (slot.value - barW.value) / 2;

// Segments bottom-up; `seam` = a 2px surface gap at the segment's top edge when another one follows
const bars = computed(() => props.days.map((d, i) => {
  let base = 0;
  const parts = SOURCES.filter((s) => d[s] > 0);
  const segments = parts.map((s, n) => {
    const y0 = yOf(base);
    base += d[s];
    const y1 = yOf(base);
    return { source: s, y: y1, h: y0 - y1, seam: n < parts.length - 1 };
  });
  return { day: d.day, i, segments, title: `${dayLabel(d.day)}: ${totalOf(d)} (${SOURCES.map((s) => `${SOURCE_LABEL[s]} ${d[s]}`).join(", ")})` };
}));

// First, middle and last day
const xLabels = computed(() => {
  const n = props.days.length;
  if (!n) return [];
  const idx = [...new Set([0, Math.floor((n - 1) / 2), n - 1])];
  return idx.map((i) => ({ i, text: dayLabel(props.days[i]!.day), anchor: i === 0 ? "start" : i === n - 1 ? "end" : "middle" }));
});

const totals = computed(() => Object.fromEntries(SOURCES.map((s) => [s, props.days.reduce((sum, d) => sum + d[s], 0)])) as Record<ActivitySource, number>);
const hover = ref<number | null>(null);
</script>

<template>
  <div class="day-bars">
    <div ref="root" class="plot">
      <svg :width="width" :height="height" role="img" @mouseleave="hover = null">
        <g class="grid">
          <template v-for="t in ticks" :key="t">
            <line :x1="PAD.left" :x2="width - PAD.right" :y1="yOf(t)" :y2="yOf(t)" />
            <text :x="PAD.left - 6" :y="yOf(t)" text-anchor="end" dominant-baseline="middle">{{ t.toLocaleString() }}</text>
          </template>
        </g>
        <rect
          v-if="hover !== null"
          class="hover-col"
          :x="PAD.left + hover * slot"
          :y="PAD.top"
          :width="slot"
          :height="plotH"
        />
        <g v-for="b in bars" :key="b.day">
          <template v-for="s in b.segments" :key="s.source">
            <rect :class="['seg', s.source]" :x="xOf(b.i)" :y="s.y" :width="barW" :height="s.h" />
            <rect v-if="s.seam" class="seam" :x="xOf(b.i)" :y="s.y - 1" :width="barW" height="2" />
          </template>
          <rect class="hit" :x="PAD.left + b.i * slot" :y="PAD.top" :width="slot" :height="plotH" @mouseenter="hover = b.i">
            <title>{{ b.title }}</title>
          </rect>
        </g>
        <g class="axis">
          <text v-for="l in xLabels" :key="l.i" :x="l.anchor === 'start' ? PAD.left : l.anchor === 'end' ? width - PAD.right : xOf(l.i) + barW / 2" :y="height - 4" :text-anchor="l.anchor">
            {{ l.text }}
          </text>
        </g>
      </svg>
    </div>
    <div class="legend">
      <span v-for="s in SOURCES" :key="s" class="key">
        <span :class="['swatch', s]" />
        {{ SOURCE_LABEL[s] }} <span class="mono dim">{{ totals[s].toLocaleString() }}</span>
      </span>
    </div>
  </div>
</template>

<style scoped>
.day-bars {
  /* Source colors: distinct from each other and from ok/warn/err (checked for color vision deficiencies;
     the web app/companion pair needs the gaps and the legend) */
  --src-bot: #5b7cf0;
  --src-webapp: #1ca2b2;
  --src-companion: #d55181;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.plot {
  width: 100%;
  overflow: hidden;
}

svg {
  display: block;
}

.grid line {
  stroke: var(--border-dim);
  stroke-width: 1;
}

text {
  fill: var(--text-3);
  font-size: 11px;
  font-family: var(--font-ui);
  font-variant-numeric: tabular-nums;
}

.seg.bot,
.swatch.bot {
  fill: var(--src-bot);
  background: var(--src-bot);
}

.seg.webapp,
.swatch.webapp {
  fill: var(--src-webapp);
  background: var(--src-webapp);
}

.seg.companion,
.swatch.companion {
  fill: var(--src-companion);
  background: var(--src-companion);
}

.seam {
  fill: var(--bg-surface);
}

.hit {
  fill: transparent;
}

.hover-col {
  fill: var(--bg-surface-2);
}

.legend {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 16px;
  font-size: 12px;
  color: var(--text-2);
}

.key {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.swatch {
  width: 10px;
  height: 10px;
  border-radius: 2px;
}
</style>
