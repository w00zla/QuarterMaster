<script setup lang="ts">
// BindSight's footer: one line with the credits and, instead of version and GitHub link, the fan
// site disclaimer towards CIG: a short line, the full text on hover; before it, after a divider, the
// third-party source (UEX: logo from its site, uex-logo-{20,40}.png Lanczos from its 960 px touch icon); the
// Star Citizen logo from the official fankit at the right edge (exact sizes from
// local/Fankit_*/03_LOGOS/STARCITIZEN_WHITE.png).
import scLogo from "../assets/sc-logo-20.png";
import scLogo2x from "../assets/sc-logo-40.png";
import uexLogo from "../assets/uex-logo-20.png";
import uexLogo2x from "../assets/uex-logo-40.png";
import { t } from "../i18n";
</script>

<template>
  <footer class="footer">
    <span class="credits">Made with ❤️ and ☕ by w00zla &amp; Claude</span>
    <span class="powered">
      {{ t("footer.poweredBy") }}
      <a href="https://uexcorp.space" target="_blank" rel="noopener noreferrer">
        <img :src="uexLogo" :srcset="`${uexLogo} 1x, ${uexLogo2x} 2x`" alt="" /> UEX
      </a>
    </span>
    <div class="divider" />
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
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* Sources, divider and disclaimer together at the right, before the logo */
.powered {
  margin-left: auto;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  gap: 10px;
  white-space: nowrap;
}

.powered a {
  display: flex;
  align-items: center;
  gap: 5px;
  color: var(--text-2);
  text-decoration: none;
}

.powered a:hover {
  color: var(--text);
}

.powered img {
  width: 20px;
  height: 20px;
  display: block;
}
</style>
