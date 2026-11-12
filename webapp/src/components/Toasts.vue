<script setup lang="ts">
// The toast stack (see toasts.ts), top right below the slim bar, newest first; a click dismisses one.
// Taken from BindSight. Notices
// (actions from the bot and the companion app) have a title and a detail line and an × to close.
import Icon from "../../../adminapp/src/components/Icon.vue";
import { topbarHeight } from "../layout";
import { dismissToast, toasts } from "../toasts";
import { t } from "../i18n";
</script>

<template>
  <div class="toasts" aria-live="polite" :style="{ top: `${topbarHeight + 16}px` }">
    <template v-for="x in toasts" :key="x.id">
      <div v-if="x.sticky" class="toast notice" :class="x.type">
        <div class="notice-text">
          <div class="notice-title">{{ x.title }}</div>
          <div><span v-if="x.label" class="notice-label">{{ x.label }} · </span>{{ x.message }}</div>
          <div v-if="x.detail" class="notice-detail">{{ x.detail }}</div>
        </div>
        <button type="button" class="close" :title="t('common.close')" @click="dismissToast(x.id)"><Icon name="close" :size="14" /></button>
      </div>
      <button v-else type="button" class="toast" :class="x.type" @click="dismissToast(x.id)">
        {{ x.message }}
      </button>
    </template>
  </div>
</template>

<style scoped>
.toasts {
  position: fixed;
  /* Below the slim bar: `top` comes from its measured height (layout.ts) */
  top: 16px;
  bottom: auto;
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

/* The accent says what kind of message it is: green done, red refused, blue a notice */
.toast.error {
  border-left-color: var(--err);
}

.toast.info {
  border-left-color: var(--accent);
}

.notice {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  cursor: default;
}

.notice-text {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.notice-title {
  color: var(--text-2);
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.1em;
  text-transform: uppercase;
}

/* What was done ("Stock · Shared"), quieter than what it was done to */
.notice-label {
  color: var(--text-2);
  font-size: 12px;
}

.notice-detail {
  color: var(--text-2);
}

.close {
  display: grid;
  place-items: center;
  flex-shrink: 0;
  padding: 2px;
  border: none;
  background: transparent;
  color: var(--text-2);
  cursor: pointer;
}

.close:hover {
  color: var(--text);
}
</style>
