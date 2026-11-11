<script setup lang="ts">
// The three window buttons of the frameless desktop window (minimize, maximize or restore, close), each in a fixed 36 px slot.
// Rendered only in the desktop shell. The close button turns to the error colour on hover.
import Icon from "../../../adminapp/src/components/Icon.vue";
import { t } from "../i18n";
import { shell } from "../shell";
</script>

<template>
  <div v-if="shell.available" class="win-btns">
    <button type="button" class="win-btn" :title="t('win.minimize')" @click="shell.minimize()"><Icon name="minimize" :size="16" /></button>
    <button type="button" class="win-btn" :title="t(shell.maximized ? 'win.restore' : 'win.maximize')" @click="shell.toggleMaximize()">
      <Icon :name="shell.maximized ? 'restore' : 'maximize'" :size="14" />
    </button>
    <button type="button" class="win-btn close" :title="t('win.close')" @click="shell.close()"><Icon name="close" :size="16" /></button>
  </div>
</template>

<style scoped>
.win-btns {
  display: flex;
  flex-shrink: 0;
  gap: 2px;
}

.win-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 36px;
  padding: 0;
  border: none;
  border-radius: var(--radius-control);
  background: transparent;
  color: var(--text-2);
  cursor: pointer;
}

.win-btn:hover {
  background: var(--bg-surface-2);
  color: var(--text);
}

.win-btn.close:hover {
  background: var(--err);
  color: var(--accent-text);
}
</style>
