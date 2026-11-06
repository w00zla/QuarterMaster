<script lang="ts">
// One question, a row of buttons, one answer. The caller decides the wording and the icon; optional
// body content (default slot) sits between title and buttons. Taken from BindSight.
import type { IconName } from "./Icon.vue";

export interface ConfirmButton {
  label: string;
  kind: "primary" | "outline" | "danger";
  value: string;
  disabled?: boolean;
  // "left" parks the button at the far left of the footer
  side?: "left";
  icon?: IconName;
  // ID of a form in the body: the button submits it (also on Enter there) instead of answering
  form?: string;
}

// Open dialogs, innermost last: only that one answers Escape (a form dialog with its confirmation on top)
const open: symbol[] = [];
</script>

<script setup lang="ts">
import { computed, onMounted, onUnmounted } from "vue";
import Icon from "./Icon.vue";

const props = defineProps<{
  title: string;
  subtitle?: string;
  icon: IconName;
  buttons: ConfirmButton[];
  // A dialog with a table in its body: wider still; xxl for a wide table with more above it (the mining places)
  xl?: boolean;
  xxl?: boolean;
}>();
const emit = defineEmits<{ choose: [value: string] }>();

// Escape answers with the first outline button (the way out), or does nothing when there is none.
// A click on the backdrop does NOT close the dialog: only Escape or a button does.
const dismiss = computed(() => props.buttons.find((b) => b.kind === "outline")?.value ?? null);

const id = Symbol("dialog");

function onKey(e: KeyboardEvent) {
  // A picker's suggestion list closes on Escape first (it stops the event)
  if (e.key !== "Escape" || e.defaultPrevented || open.at(-1) !== id) return;
  if (dismiss.value !== null) emit("choose", dismiss.value);
}

onMounted(() => {
  open.push(id);
  window.addEventListener("keydown", onKey);
});
onUnmounted(() => {
  open.splice(open.indexOf(id), 1);
  window.removeEventListener("keydown", onKey);
});
</script>

<template>
  <Teleport to="body">
    <div class="backdrop">
      <div class="dialog" :class="{ wide: !!$slots.default, xl, xxl }" role="dialog" aria-modal="true" :aria-label="title">
        <div class="head">
          <Icon :name="icon" :size="18" />
          <div class="titles">
            <span class="title">{{ title }}</span>
            <span v-if="subtitle" class="subtitle">{{ subtitle }}</span>
          </div>
          <!-- Optional controls at the head's right end -->
          <slot name="head" />
        </div>
        <div v-if="$slots.default" class="body">
          <slot />
        </div>
        <div class="foot">
          <button
            v-for="b in buttons"
            :key="b.value"
            :type="b.form ? 'submit' : 'button'"
            :form="b.form"
            class="btn"
            :class="[b.kind, { left: b.side === 'left' }]"
            :disabled="b.disabled"
            @click="b.form || emit('choose', b.value)"
          >
            <Icon v-if="b.icon" :name="b.icon" :size="14" /> {{ b.label }}
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
/* Scrolls as a whole on small screens; the dialog does not clip (picker suggestion lists overlap it) */
.backdrop {
  position: fixed;
  inset: 0;
  background: rgba(4, 12, 18, 0.85);
  display: flex;
  align-items: flex-start;
  justify-content: center;
  padding: 10vh 16px 16px;
  overflow-y: auto;
  z-index: 60;
}

.dialog {
  width: min(420px, 100%);
  background: var(--bg-surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-panel);
  display: flex;
  flex-direction: column;
}

/* A dialog with body content gets more room */
.dialog.wide {
  width: min(560px, 100%);
}

.dialog.xl {
  width: min(900px, 100%);
}

.dialog.xxl {
  width: min(1240px, 100%);
}

.head,
.foot {
  display: flex;
  align-items: center;
  padding: 16px 20px;
}

.head {
  gap: 10px;
  border-bottom: 1px solid var(--border-dim);
}

.body {
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding: 18px 20px;
}

.foot {
  justify-content: flex-end;
  flex-wrap: wrap;
  gap: 8px;
  border-top: 1px solid var(--border-dim);
}

.titles {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.title {
  font-weight: 600;
  font-size: 18px;
}

.subtitle {
  font-size: 12px;
  color: var(--text-2);
}

.btn {
  height: var(--h-control);
  font-size: 14px;
}

.btn.danger {
  background: transparent;
  color: var(--err);
  border: 1px solid color-mix(in srgb, var(--err) 60%, transparent);
}

.btn.left {
  margin-right: auto;
}
</style>
