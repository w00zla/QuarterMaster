<script setup lang="ts">
// BindSight's footer: one line with the credits and, instead of version and GitHub link, the fan
// site disclaimer towards CIG: a short line, the full text on hover; the Star Citizen logo from the
// official fankit at the right edge (exact sizes from local/Fankit_*/03_LOGOS/STARCITIZEN_WHITE.png).
import scLogo from "../assets/sc-logo-20.png";
import scLogo2x from "../assets/sc-logo-40.png";
import { t } from "../i18n";
</script>

<template>
  <footer class="footer">
    <span class="credits">Made with ❤️ and ☕ by w00zla &amp; Claude</span>
    <span class="disclaimer" :title="t('footer.disclaimer')">{{ t("footer.disclaimerShort") }}</span>
    <img class="sc-logo" :src="scLogo" :srcset="`${scLogo} 1x, ${scLogo2x} 2x`" alt="Star Citizen" />
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

.sc-logo {
  flex-shrink: 0;
  height: 20px;
  display: block;
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
