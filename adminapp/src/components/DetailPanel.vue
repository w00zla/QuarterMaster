<script setup lang="ts">
// Right-hand detail panel of a list view: head with title (its technical id in a
// tooltip) and a close button, scrolling body. Loading and error states are handled here.
import Icon, { type IconName } from "./Icon.vue";
import Tooltip from "./Tooltip.vue";

defineProps<{ icon: IconName; title: string; technical?: string; loading?: boolean; error?: string }>();
const emit = defineEmits<{ close: [] }>();
</script>

<template>
  <section class="panel detail">
    <div class="head">
      <Icon :name="icon" :size="16" />
      <div class="titles">
        <Tooltip :text="technical" mono><span class="head-title">{{ title }}</span></Tooltip>
      </div>
      <button type="button" class="icon-btn" title="Close" @click="emit('close')">
        <Icon name="close" :size="16" />
      </button>
    </div>
    <div class="body">
      <div v-if="error" class="empty-line">{{ error }}</div>
      <div v-else-if="loading" class="empty-line">Loading…</div>
      <slot v-else />
    </div>
  </section>
</template>

<style scoped>
.detail {
  width: 560px;
  flex-shrink: 0;
}

.titles {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.body {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 20px;
}

.body :deep(section) {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
</style>
