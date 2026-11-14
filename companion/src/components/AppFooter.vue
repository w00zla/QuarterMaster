<script setup lang="ts">
// The main window's footer, the desktop app's (webapp/src/components/AppFooter.vue) without the third-party source: one line
// with the credits and, at the right, the fan site disclaimer towards CIG (a short line, the full text on hover) with the
// Star Citizen logo from the official fankit, then after a divider BindSight's right end: the app logo, the version (logo and
// version open the App Update dialog, UpdateDialog.vue), the link to the GitHub page (opened in the system's browser by the
// Rust side: a plain link would navigate this webview) and at the far right the update mark while one was found (its room is
// kept: nothing moves when it appears, and it keeps the link off the window's resize corner).
import { computed } from "vue";
import Icon from "../../../adminapp/src/components/Icon.vue";
import logo from "../assets/logo-44.png";
import scLogo from "../../../webapp/src/assets/sc-logo-20.png";
import scLogo2x from "../../../webapp/src/assets/sc-logo-40.png";
import { openUpdate, update } from "../appUpdate";
import { openRepo } from "../backend";
import { t } from "../i18n";
import { toastError } from "../toasts";
import { updateFound } from "../../../webapp/src/shellLogic.ts";

defineProps<{ version: string | null }>();
const found = computed(() => !!update.value && updateFound(update.value));
</script>

<template>
  <footer class="footer">
    <span class="credits">Made with ❤️ and ☕ by w00zla &amp; Claude</span>
    <span class="disclaimer" :title="t('footer.disclaimer')">{{ t("footer.disclaimerShort") }}</span>
    <img class="sc-logo" :src="scLogo" :srcset="`${scLogo} 1x, ${scLogo2x} 2x`" alt="Star Citizen" />
    <div class="divider" />
    <span class="meta">
      <img class="logo" :src="logo" alt="" @click="openUpdate" />
      <!-- The room is kept while the version is not known yet: nothing moves when it arrives -->
      <button type="button" class="version mono" :title="t('update.button')" @click="openUpdate">{{ version ? `v${version}` : "" }}</button>
      <button type="button" class="repo" @click="openRepo().catch(toastError)"><Icon name="github" :size="14" fill="currentColor" /> GitHub</button>
      <button type="button" class="mark" :class="{ off: !found }" :tabindex="found ? 0 : -1" :title="t('update.mark')" @click="openUpdate"><Icon name="imports" :size="14" /></button>
    </span>
  </footer>
</template>

<style scoped>
.footer {
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
  user-select: none;
}

.credits {
  flex-shrink: 0;
  white-space: nowrap;
}

/* Disclaimer with its logo and the app's own end together at the right; the disclaimer gives way first */
.disclaimer {
  margin-left: auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.sc-logo {
  flex-shrink: 0;
  height: 20px;
  display: block;
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
  min-width: 6ch;
  padding: 0;
  border: none;
  background: none;
  text-align: left;
  font-size: 12px;
  color: var(--text-2);
  cursor: pointer;
}

.version:hover {
  color: var(--accent);
  text-decoration: underline;
}

/* The update mark: its 14 px stay reserved while there is no update (hidden, not removed) */
.mark {
  display: inline-flex;
  padding: 0;
  border: none;
  background: none;
  color: var(--accent);
  cursor: pointer;
}

.mark.off {
  visibility: hidden;
}

.repo {
  margin-left: 10px;
  padding: 0;
  border: none;
  background: none;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font: inherit;
  color: var(--text-2);
  white-space: nowrap;
  cursor: pointer;
}

.repo:hover {
  color: var(--accent);
  text-decoration: underline;
}
</style>
