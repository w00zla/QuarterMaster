<script setup lang="ts">
// A small line over days (KPI tiles): to scale from 0 to the highest value, no axes; each day has a hover
// title. Stretches to its container's width (the stroke keeps its width).
import { computed } from "vue";
import type { DayCount } from "../../../src/adminapp/api-types";
import { dayLabel } from "../activity";

const props = withDefaults(defineProps<{ series: DayCount[]; height?: number; unit?: string }>(), { height: 32, unit: "" });

// viewBox units: one per day across, 100 high
const max = computed(() => Math.max(1, ...props.series.map((d) => d.count)));
const x = (i: number) => (props.series.length > 1 ? (i / (props.series.length - 1)) * 100 : 50);
const y = (v: number) => 100 - (v / max.value) * 96 - 2;
const line = computed(() => props.series.map((d, i) => `${i ? "L" : "M"}${x(i)},${y(d.count)}`).join(""));
const area = computed(() => (props.series.length ? `${line.value}L${x(props.series.length - 1)},100L${x(0)},100Z` : ""));
const step = computed(() => 100 / Math.max(props.series.length - 1, 1));
</script>

<template>
  <svg class="spark" viewBox="0 0 100 100" preserveAspectRatio="none" :style="{ height: `${height}px` }" role="img">
    <path class="area" :d="area" />
    <path class="line" :d="line" vector-effect="non-scaling-stroke" />
    <rect
      v-for="(d, i) in series"
      :key="d.day"
      class="hit"
      :x="x(i) - step / 2"
      y="0"
      :width="step"
      height="100"
    >
      <title>{{ dayLabel(d.day) }}: {{ d.count.toLocaleString() }}{{ unit ? ` ${unit}` : "" }}</title>
    </rect>
  </svg>
</template>

<style scoped>
.spark {
  display: block;
  width: 100%;
  overflow: visible;
}

.line {
  fill: none;
  stroke: var(--accent);
  stroke-width: 2px;
  stroke-linejoin: round;
}

.area {
  fill: color-mix(in srgb, var(--accent) 14%, transparent);
}

.hit {
  fill: transparent;
}

.hit:hover {
  fill: color-mix(in srgb, var(--text) 8%, transparent);
}
</style>
