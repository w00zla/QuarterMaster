<script setup lang="ts">
// BindSight's footer: one line with the credits and, instead of version and GitHub link, the fan
// site disclaimer towards CIG (cut off with an ellipsis on narrow screens, the full text on hover).
import { t } from "../i18n";
</script>

<template>
  <footer class="footer">
    <span class="credits">Made with ❤️ and ☕ by w00zla &amp; Claude</span>
    <span class="disclaimer" :title="t('footer.disclaimer')">{{ t("footer.disclaimer") }}</span>
  </footer>
</template>

<style scoped>
.footer {
  position: sticky;
  bottom: 0;
  z-index: 30;
  height: 28px;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 0 16px;
  background: var(--bg-surface);
  border-top: 1px solid var(--border-dim);
  font-size: 12px;
  color: var(--text-3);
}

.credits {
  flex-shrink: 0;
  white-space: nowrap;
}

.disclaimer {
  flex: 1;
  min-width: 0;
  text-align: right;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
