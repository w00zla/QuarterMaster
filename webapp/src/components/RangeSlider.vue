<script setup lang="ts">
// A min-max slider: two native range inputs on one track (only their thumbs take the pointer), the
// chosen range filled in between. Fixed width, the value text keeps its width too.
import { computed } from "vue";

const props = withDefaults(defineProps<{ min: number; max: number; step?: number; label: string }>(), { step: 10 });
const low = defineModel<number>("low", { required: true });
const high = defineModel<number>("high", { required: true });

const setLow = (v: number) => (low.value = Math.min(v, high.value));
const setHigh = (v: number) => (high.value = Math.max(v, low.value));
const pct = (v: number) => ((v - props.min) / (props.max - props.min)) * 100;
const fill = computed(() => ({ left: `${pct(low.value)}%`, width: `${pct(high.value) - pct(low.value)}%` }));
</script>

<template>
  <div class="range" :title="`${label} ${low}–${high}`">
    <span class="caption">{{ label }}</span>
    <div class="track">
      <div class="fill" :style="fill" />
      <input type="range" :min="min" :max="max" :step="step" :value="low" :aria-label="`${label} min`"
        @input="setLow(Number(($event.target as HTMLInputElement).value))" />
      <input type="range" :min="min" :max="max" :step="step" :value="high" :aria-label="`${label} max`"
        @input="setHigh(Number(($event.target as HTMLInputElement).value))" />
    </div>
    <span class="value">{{ low }}–{{ high }}</span>
  </div>
</template>

<style scoped>
.range {
  display: flex;
  align-items: center;
  gap: 10px;
  height: var(--h-chip);
  padding: 0 12px;
  border-radius: var(--radius-control);
  background: var(--bg-surface-2);
  font-size: 13px;
  color: var(--text-2);
}

.caption {
  font-weight: 600;
  color: var(--text);
}

.track {
  position: relative;
  width: 140px;
  height: 4px;
  border-radius: 2px;
  background: var(--bg-surface-3);
}

.fill {
  position: absolute;
  top: 0;
  height: 100%;
  border-radius: 2px;
  background: var(--accent);
}

/* Both inputs lie on the track; only the thumbs react */
.track input {
  position: absolute;
  inset: -6px 0;
  width: 100%;
  height: 16px;
  margin: 0;
  background: none;
  pointer-events: none;
  appearance: none;
}

.track input::-webkit-slider-thumb {
  appearance: none;
  width: 14px;
  height: 14px;
  border-radius: 50%;
  border: 2px solid var(--bg-surface);
  background: var(--accent);
  cursor: pointer;
  pointer-events: auto;
}

.track input::-moz-range-thumb {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  border: 2px solid var(--bg-surface);
  background: var(--accent);
  cursor: pointer;
  pointer-events: auto;
}

.track input::-moz-range-track {
  background: none;
}

/* "1000–1000" at most: the width never changes while dragging */
.value {
  min-width: 9ch;
  font-variant-numeric: tabular-nums;
  text-align: right;
  color: var(--text);
}
</style>
