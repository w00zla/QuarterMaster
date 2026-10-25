<script setup lang="ts">
// An item's thumbnail in a fixed box (`px` CSS px, the file `size`): without a hash, or when it fails to
// load, the fallback icon in the same box (nothing moves). Lazy; no alt text (the name stands next to it).
import { ref, watch } from "vue";
import Icon, { type IconName } from "../../../adminapp/src/components/Icon.vue";
import { thumbPath, type ThumbSize } from "../../../src/thumbs";

const props = withDefaults(defineProps<{
  uuid: string;
  hash: string | null;
  size: ThumbSize;
  px: number;
  icon: IconName;
  iconSize?: number;
}>(), { iconSize: undefined });

const failed = ref(false);
watch(() => [props.uuid, props.hash], () => (failed.value = false));
</script>

<template>
  <span class="thumb" :style="{ width: `${px}px`, height: `${px}px` }">
    <img
      v-if="hash && !failed"
      :src="thumbPath(size, uuid, hash)"
      :width="px"
      :height="px"
      loading="lazy"
      decoding="async"
      alt=""
      @error="failed = true"
    />
    <Icon v-else :name="icon" :size="iconSize ?? Math.round(px * 0.75)" class="thumb-icon" />
  </span>
</template>

<style scoped>
.thumb {
  display: inline-flex;
  flex-shrink: 0;
  align-items: center;
  justify-content: center;
  vertical-align: middle;
}

.thumb img {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: contain;
}

/* As the type icons it stands in for */
.thumb-icon {
  opacity: 0.8;
}
</style>
