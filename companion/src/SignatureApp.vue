<script setup lang="ts">
// The signature overlay's page (Rust: overlay.rs places the window next to the radar signature; the main window's
// side: mining.ts): a small tile with the resources the newest signature can stand for, one per line after the
// mining method's icon (ship, ROC, hand), read-only
// (the window ignores the mouse). The tile sits at the window's side facing the number (the settings' position:
// below the number = the top edge, centred), the rest of the window stays transparent; as see-through as the scan
// overlay. Everything comes as text in the UI language from the main window ("signature-view", on every change and
// when this page asks).
import { computed, onMounted, ref } from "vue";
import { emit, listen } from "@tauri-apps/api/event";
import Icon from "../../adminapp/src/components/Icon.vue";
import type { SignatureView } from "./mining";

const view = ref<SignatureView | null>(null);
// Where in the window the tile sits: at the side facing the number
const PLACE = { below: "top", above: "bottom", left: "right", right: "left" } as const;
const place = computed(() => PLACE[view.value?.position ?? "below"]);

onMounted(async () => {
  await listen<SignatureView>("signature-view", (e) => (view.value = e.payload));
  await emit("signature-request");
});
</script>

<template>
  <div v-if="view" class="frame" :class="place">
    <section class="tile" :class="{ none: view.none }" :style="{ '--opaque': `${100 - view.transparency}%` }">
      <span v-for="(line, i) in view.lines" :key="i" class="line"><Icon v-if="line.icon" :name="line.icon" :size="12" />{{ line.text }}</span>
    </section>
  </div>
</template>

<style>
/* Only the tile shows: the window itself is transparent */
html,
body,
#app {
  height: 100%;
  margin: 0;
  overflow: hidden;
  background: transparent;
}
</style>

<style scoped>
.frame {
  display: flex;
  height: 100%;
  box-sizing: border-box;
}

.frame.top {
  align-items: flex-start;
  justify-content: center;
}

.frame.bottom {
  align-items: flex-end;
  justify-content: center;
}

.frame.left {
  align-items: center;
  justify-content: flex-start;
}

.frame.right {
  align-items: center;
  justify-content: flex-end;
}

/* Like the scan overlay's tile */
.tile {
  display: flex;
  flex-direction: column;
  max-width: 100%;
  max-height: 100%;
  box-sizing: border-box;
  overflow: hidden;
  padding: 4px 8px;
  border: 1px solid var(--border-dim);
  border-radius: var(--radius-panel);
  background: color-mix(in srgb, var(--bg-surface) var(--opaque, 82%), transparent);
  font-size: 12px;
  font-weight: 600;
  line-height: 20px;
}

.line {
  display: flex;
  align-items: center;
  gap: 5px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.line > svg {
  flex-shrink: 0;
  color: var(--text-2);
}

/* No resource fits: the line in the warning colour */
.tile.none {
  color: var(--warn);
  font-weight: 400;
}
</style>
