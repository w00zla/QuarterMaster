<script setup lang="ts">
// Collapsible raw game record, pretty-printed, with a copy button.
import { computed, ref } from "vue";
import Icon from "./Icon.vue";

// `unfolded`: shown open at first (the activity list's expanded row)
const props = defineProps<{ value: unknown; label?: string; unfolded?: boolean }>();
const open = ref(props.unfolded ?? false);
const copied = ref(false);
const text = computed(() => JSON.stringify(props.value, null, 2));

async function copy() {
  await navigator.clipboard.writeText(text.value);
  copied.value = true;
  setTimeout(() => (copied.value = false), 1500);
}
</script>

<template>
  <section>
    <div class="raw-head">
      <button type="button" class="toggle" @click="open = !open">
        <Icon :name="open ? 'chevron-down' : 'chevron-right'" :size="14" />
        <span class="panel-title">{{ label ?? "Raw record" }}</span>
        <span class="faint size">{{ (text.length / 1024).toFixed(1) }} KB</span>
      </button>
      <button v-if="open" type="button" class="icon-btn" :title="copied ? 'Copied' : 'Copy'" @click="copy">
        <Icon :name="copied ? 'check' : 'copy'" :size="14" />
      </button>
    </div>
    <pre v-if="open" class="mono">{{ text }}</pre>
  </section>
</template>

<style scoped>
.raw-head {
  display: flex;
  align-items: center;
  gap: 8px;
}

.toggle {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 0;
  border: none;
  background: transparent;
  color: var(--text-2);
  cursor: pointer;
  font-family: inherit;
}

.size {
  font-size: 11px;
}

pre {
  margin: 0;
  max-height: 480px;
  overflow: auto;
  padding: 12px;
  border-radius: var(--radius-control);
  background: var(--bg-base);
  color: var(--text-2);
  font-size: 12px;
  line-height: 1.45;
}
</style>
