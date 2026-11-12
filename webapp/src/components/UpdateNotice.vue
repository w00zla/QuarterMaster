<script setup lang="ts">
// The bold notice above every view: the newest game data needs a newer app. The button only where the desktop shell
// offers app updates (shell.ts); in a browser there is the notice alone.
import Icon from "../../../adminapp/src/components/Icon.vue";
import { t } from "../i18n";
import { shell } from "../shell";
</script>

<template>
  <div class="update-notice" role="alert">
    <Icon name="warning" :size="20" />
    <div class="texts">
      <strong>{{ t("update.title") }}</strong>
      <span>{{ t("update.text") }}</span>
    </div>
    <button v-if="shell.updateAvailable" class="btn primary" type="button" @click="shell.openUpdate()">
      <Icon name="imports" :size="14" /> {{ t("update.button") }}
    </button>
  </div>
</template>

<style scoped>
.update-notice {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 12px;
  width: 100%;
  max-width: 1440px;
  margin: 0 auto 12px;
  padding: 14px 16px;
  box-sizing: border-box;
  background: var(--bg-surface);
  border: 1px solid var(--warn);
  border-radius: var(--radius-panel);
  color: var(--warn);
}

.texts {
  flex: 1;
  min-width: 220px;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

strong {
  font-size: 16px;
  font-weight: 700;
  color: var(--text);
}

.texts span {
  font-size: 13px;
  color: var(--text-2);
}
</style>
