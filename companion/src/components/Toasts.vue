<script setup lang="ts">
// The toast stack (see toasts.ts), bottom right; a click dismisses one. Like the web app's.
import { dismissToast, toasts } from "../toasts";
</script>

<template>
  <div class="toasts" aria-live="polite">
    <button v-for="x in toasts" :key="x.id" type="button" class="toast" :class="x.type" @click="dismissToast(x.id)">
      {{ x.message }}
    </button>
  </div>
</template>

<style scoped>
.toasts {
  position: fixed;
  bottom: 16px;
  right: 16px;
  left: 16px;
  display: flex;
  flex-direction: column-reverse;
  align-items: flex-end;
  gap: 8px;
  z-index: 1000;
  pointer-events: none;
}

.toast {
  pointer-events: auto;
  background: var(--bg-surface-2);
  border: none;
  border-radius: 6px;
  padding: 10px 14px;
  font-family: inherit;
  font-size: 13px;
  text-align: left;
  color: var(--text);
  border-left: 3px solid var(--ok);
  max-width: min(24rem, 100%);
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.4);
  cursor: pointer;
}

.toast.error {
  border-left-color: var(--err);
}
</style>
