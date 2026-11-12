<script setup lang="ts">
// BindSight's footer: one line with the credits and, at the right, the fan site disclaimer towards CIG (a short line, the full
// text on hover) with the Star Citizen logo from the official fankit (exact sizes from
// local/Fankit_*/03_LOGOS/STARCITIZEN_WHITE.png), then after a divider the third-party source (UEX: logo from its site,
// uex-logo-{20,40}.png Lanczos from its 960 px touch icon). The line ends as BindSight's does, after another divider: (singleuser) the app
// logo and the link to the GitHub page; the singleuser app (no login) also shows the update mark while one was found and its
// version after the logo (logo and version open the App Update dialog where the desktop shell offers updates; plain in a
// browser). Online there is no app version: the GitHub link only.
import { computed } from "vue";
import Icon from "../../../adminapp/src/components/Icon.vue";
import { localApp } from "../capabilities";
import { settings } from "../local";
import { shell } from "../shell";
import { updateFound } from "../shellLogic";
import logo from "../../../adminapp/src/assets/logo-128.png";
import scLogo from "../assets/sc-logo-20.png";
import scLogo2x from "../assets/sc-logo-40.png";
import uexLogo from "../assets/uex-logo-20.png";
import uexLogo2x from "../assets/uex-logo-40.png";
import { t } from "../i18n";

const version = computed(() => (localApp.value && settings.value ? `v${settings.value.appVersion}` : null));
const REPO_URL = "https://github.com/w00zla/quartermaster";
const found = computed(() => !!shell.update && updateFound(shell.update));
</script>

<template>
  <footer class="footer">
    <span class="credits">Made with ❤️ and ☕ by w00zla &amp; Claude</span>
    <span class="disclaimer" :title="t('footer.disclaimer')">{{ t("footer.disclaimerShort") }}</span>
    <img class="sc-logo" :src="scLogo" :srcset="`${scLogo} 1x, ${scLogo2x} 2x`" alt="Star Citizen" />
    <div class="divider" />
    <span class="powered">
      {{ t("footer.poweredBy") }}
      <a href="https://uexcorp.space" target="_blank" rel="noopener noreferrer">
        <img :src="uexLogo" :srcset="`${uexLogo} 1x, ${uexLogo2x} 2x`" alt="" /> UEX
      </a>
    </span>
    <!-- BindSight's right end (its AppFooter.vue), after a divider: the update mark while one was found, the app logo, the
         version (singleuser only) and the GitHub page (the desktop shell opens the link in the system's browser, shell.ts). Logo
         and version open the App Update dialog where the shell offers updates -->
    <div class="divider" />
    <span class="meta">
      <button v-if="found" class="mark" type="button" :title="t('update.mark')" @click="shell.openUpdate()"><Icon name="imports" :size="14" /></button>
      <img v-if="version" class="logo" :class="{ plain: !shell.updateAvailable }" :src="logo" alt="" @click="shell.updateAvailable && shell.openUpdate()" />
      <template v-if="version">
        <button v-if="shell.updateAvailable" class="version mono" type="button" :title="t('update.button')" @click="shell.openUpdate()">{{ version }}</button>
        <span v-else class="version plain mono">{{ version }}</span>
      </template>
      <a class="repo" :href="REPO_URL" target="_blank" rel="noopener noreferrer"><Icon name="github" :size="14" fill="currentColor" /> GitHub</a>
    </span>
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

/* The right end, the values of BindSight's footer */
.meta {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  gap: 10px;
}

.logo {
  width: 16px;
  height: 16px;
  display: block;
  cursor: pointer;
}

.version {
  padding: 0;
  border: none;
  background: none;
  font-size: 12px;
  color: var(--text-2);
  cursor: pointer;
}

.version:hover {
  color: var(--accent);
  text-decoration: underline;
}

/* In a browser there is no update to open: text and a picture, nothing to click */
.logo.plain,
.version.plain {
  cursor: default;
}

.version.plain:hover {
  color: var(--text-2);
  text-decoration: none;
}

.mark {
  display: inline-flex;
  padding: 0;
  border: none;
  background: none;
  color: var(--accent);
  cursor: pointer;
}

.repo {
  margin-left: 10px;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  color: var(--text-2);
  text-decoration: none;
  white-space: nowrap;
}

.repo:hover {
  color: var(--accent);
  text-decoration: underline;
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

/* Disclaimer with its logo, divider and sources together at the right (before the app's version, where there is one) */
.disclaimer {
  margin-left: auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.powered {
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
