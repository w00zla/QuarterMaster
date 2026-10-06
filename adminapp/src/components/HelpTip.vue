<script setup lang="ts">
// An info icon with a short help text (see Tooltip).
import Icon from "./Icon.vue";
import Tooltip from "./Tooltip.vue";

defineProps<{ text: string }>();
</script>

<template>
  <Tooltip :text="text">
    <span class="help" tabindex="0" @click.stop><Icon name="info" :size="13" /></span>
  </Tooltip>
</template>

<style scoped>
.help {
  display: inline-flex;
  color: var(--text-3);
  cursor: help;
  outline: none;
}

.help:hover,
.help:focus-visible {
  color: var(--accent);
}
</style>
