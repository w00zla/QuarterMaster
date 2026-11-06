<script setup lang="ts">
// An item thumbnail (thumbs.ts) in a fixed square of `px` CSS px: the place stays while it loads and
// stays empty when there is none (no hash, a failed load), so nothing moves.
import { computed, ref, watch } from "vue";
import type { ThumbSize } from "../backend";
import { loadThumb, type ThumbRef } from "../thumbs";

const props = defineProps<{ item: ThumbRef | null | undefined; size: ThumbSize; px: number }>();
const src = ref<string | null>(null);
const key = computed(() => (props.item ? `${props.size}/${props.item.uuid}.${props.item.hash}` : null));
watch(key, async (k) => {
  src.value = null;
  if (!k || !props.item) return;
  const url = await loadThumb(props.size, props.item);
  // Still the same item
  if (key.value === k) src.value = url;
}, { immediate: true });
const box = computed(() => ({ width: `${props.px}px`, height: `${props.px}px` }));
</script>

<template>
  <img v-if="src" class="thumb" :src="src" alt="" draggable="false" :style="box" />
  <span v-else class="thumb" :style="box" />
</template>

<style scoped>
.thumb {
  display: inline-block;
  flex-shrink: 0;
  vertical-align: middle;
  object-fit: contain;
}
</style>
