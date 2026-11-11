<script setup lang="ts">
// BindSight's footer: one line with the credits and, instead of version and GitHub link, the fan
// site disclaimer towards CIG: a short line, the full text on hover; before it, after a divider, the
// third-party source (UEX: logo from its site, uex-logo-{20,40}.png Lanczos from its 960 px touch icon); the
// Star Citizen logo from the official fankit at the right edge (exact sizes from
// local/Fankit_*/03_LOGOS/STARCITIZEN_WHITE.png). The singleuser app (no login) starts the line with its version: a button that
// opens the App Update dialog where the desktop shell offers updates (plain text in a browser), and the mark while one was found.
import { computed } from "vue";
import Icon from "../../../adminapp/src/components/Icon.vue";
import { loginNone } from "../capabilities";
import { settings } from "../local";
import { shell } from "../shell";
import { updateFound } from "../shellLogic";
import scLogo from "../assets/sc-logo-20.png";
import scLogo2x from "../assets/sc-logo-40.png";
import uexLogo from "../assets/uex-logo-20.png";
import uexLogo2x from "../assets/uex-logo-40.png";
import { t } from "../i18n";

const version = computed(() => (loginNone.value && settings.value ? `v${settings.value.appVersion}` : null));
const found = computed(() => !!shell.update && updateFound(shell.update));
</script>

<template>
  <footer class="footer">
    <template v-if="version">
      <button v-if="shell.updateAvailable" class="version mono" type="button" :title="t('update.button')" @click="shell.openUpdate()">{{ version }}</button>
      <span v-else class="version plain mono">{{ version }}</span>
      <!-- The mark's room is kept while there is none: nothing moves when it appears -->
      <button v-if="shell.updateAvailable" class="mark" :class="{ hidden: !found }" type="button" :title="t('update.mark')" :tabindex="found ? 0 : -1" :aria-hidden="!found" @click="shell.openUpdate()">
        <Icon name="imports" :size="14" />
      </button>
    </template>
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

/* The version button: the footer's height less the borders, the same size whatever it shows */
.version {
  flex-shrink: 0;
  height: 22px;
  padding: 0 8px;
  box-sizing: border-box;
  border: 1px solid var(--border);
  border-radius: var(--radius-control);
  background: transparent;
  color: var(--text-2);
  font-size: 12px;
  cursor: pointer;
}

.version:hover {
  color: var(--text);
  border-color: var(--text-3);
}

/* In a browser there is no update to open: text, not a dead button */
.version.plain {
  display: inline-flex;
  align-items: center;
  border-color: transparent;
  padding: 0;
  cursor: default;
}

.version.plain:hover {
  color: var(--text-2);
  border-color: transparent;
}

.mark {
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 14px;
  height: 14px;
  margin-left: -8px;
  padding: 0;
  border: none;
  background: none;
  color: var(--accent);
  cursor: pointer;
}

.mark.hidden {
  visibility: hidden;
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
