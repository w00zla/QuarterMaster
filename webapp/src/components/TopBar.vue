<script setup lang="ts">
// The app bar in the admin UI's look: wordmark, tabs, then the companion app (Access Key, download),
// the user with avatar, profile, your history and logout.
import { computed, onMounted, onUnmounted, ref } from "vue";
import { RouterLink } from "vue-router";
import Icon, { type IconName } from "../../../adminapp/src/components/Icon.vue";
import logo from "../../../adminapp/src/assets/logo-128.png";
import { capabilities, gameLabel } from "../capabilities";
import { t, type Key } from "../i18n";
import { topbarHeight } from "../layout";
import { navGroups, userControls } from "../navigation";
import { logout, me } from "../session";
import { shell } from "../shell";
import CompanionDialog from "./CompanionDialog.vue";
import ProfileDialog from "./ProfileDialog.vue";
import WindowButtons from "./WindowButtons.vue";

// The overview on its own, then the data views, then the tools (as in the admin UI): which tabs exist follows the
// server's capabilities (no buy/sell tab without UEX data)
const groups = computed(() => navGroups(capabilities.value));
// Without a login there is no user, profile, logout or companion download; the settings button takes their place
const controls = computed(() => userControls(capabilities.value));
// Features (docs/webapp.md "Features and privileges"): a button left of Companion for whoever holds the privilege
const privilegeTabs: Array<{ to: string; label: Key; icon: IconName; key: string }> = [
  { to: "/feature/thumb-review", label: "nav.thumbReview", icon: "eye", key: "thumb-review.mark" },
];
const supportTabs = computed(() => privilegeTabs.filter((tab) => me.value?.privileges.includes(tab.key)));

// The attribute's mere presence marks a drag region (not in a browser)
const drag = computed(() => (shell.available ? "" : undefined));

const profileOpen = ref(false);
const companionOpen = ref(false);

// The bar's height (it wraps on narrow screens): the toasts sit right below it
const bar = ref<HTMLElement | null>(null);
const observer = new ResizeObserver(([e]) => (topbarHeight.value = e!.target.getBoundingClientRect().height));
onMounted(() => bar.value && observer.observe(bar.value));
onUnmounted(() => {
  observer.disconnect();
  topbarHeight.value = 0;
});
</script>

<template>
  <!-- In the desktop shell the window has no frame: this bar is the title bar (`data-tauri-drag-region` only where nothing is clickable) -->
  <header ref="bar" class="topbar" :class="{ framed: shell.available }" :data-tauri-drag-region="drag">
    <div class="brand" :data-tauri-drag-region="drag">
      <img class="logo" :src="logo" alt="" :data-tauri-drag-region="drag" />
      <span class="wordmark" :data-tauri-drag-region="drag">QUARTER<span class="accent">MASTER</span></span>
    </div>
    <!-- Three bars: the overview, the data views, the tools -->
    <div class="navs" :data-tauri-drag-region="drag">
      <nav v-for="(group, i) in groups" :key="i" class="tabs" :data-tauri-drag-region="drag">
        <RouterLink v-for="tab in group" :key="tab.to" :to="tab.to" class="tab" :class="{ active: $route.path === tab.to }">
          <Icon :name="tab.icon" :size="16" /> {{ t(tab.label) }}
        </RouterLink>
      </nav>
    </div>
    <div class="spacer" :data-tauri-drag-region="drag" />
    <!-- The game version of the installed data (both variants); a fixed width, so the dash and the number take the same room -->
    <span class="ver-chip fixed" :class="{ none: !gameLabel }" :title="t('nav.gameVersion')" :data-tauri-drag-region="drag"><span class="ver-label" :data-tauri-drag-region="drag">{{ t("nav.game") }}</span>{{ gameLabel ?? "–" }}</span>
    <template v-if="controls.companion">
      <RouterLink v-for="tab in supportTabs" :key="tab.to" :to="tab.to" class="btn small outline support" :class="{ active: $route.path === tab.to }">
        <Icon :name="tab.icon" :size="14" /> {{ t(tab.label) }}
      </RouterLink>
      <button class="btn small outline" type="button" @click="companionOpen = true"><Icon name="desktop" :size="14" /> {{ t("companion.open") }}</button>
      <CompanionDialog v-if="companionOpen" @close="companionOpen = false" />
    </template>
    <span class="tab-divider" />
    <span v-if="controls.user && me" class="user">
      <img v-if="me.avatarUrl" class="avatar" :src="me.avatarUrl" alt="" />
      <span class="name">{{ me.name }}</span>
    </span>
    <button v-if="controls.profile && me" class="icon-btn" type="button" :title="t('profile.open')" @click="profileOpen = true"><Icon name="settings" :size="15" /></button>
    <ProfileDialog v-if="profileOpen" @close="profileOpen = false" />
    <RouterLink to="/history" class="icon-btn link-btn" :class="{ active: $route.path === '/history' }" :title="t('nav.history')">
      <Icon name="history" :size="15" />
    </RouterLink>
    <RouterLink v-if="controls.settings" to="/settings" class="icon-btn link-btn" :class="{ active: $route.path === '/settings' }" :title="t('nav.settings')">
      <Icon name="settings" :size="15" />
    </RouterLink>
    <button v-if="controls.logout" class="icon-btn" type="button" :title="t('user.logout')" @click="logout"><Icon name="log-out" :size="15" /></button>
    <!-- The window buttons, at the top right in their own slots (the bar may wrap: they stay in the first row) -->
    <WindowButtons class="win-top" />
  </header>
</template>

<style scoped>
.topbar {
  position: sticky;
  top: 0;
  z-index: 30;
  min-height: 56px;
  flex-shrink: 0;
  flex-wrap: wrap;
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 0 16px;
  background: var(--bg-surface);
  border-bottom: 1px solid var(--border-dim);
}

/* The title bar of the frameless window: not selectable, the window buttons close to the edge */
.topbar.framed {
  /* Room for the three 36 px buttons (and their gaps) at the top right */
  padding-right: 128px;
  user-select: none;
}

.win-top {
  position: absolute;
  top: 10px;
  right: 8px;
}

.brand {
  display: flex;
  align-items: center;
  gap: 10px;
}

.logo {
  /* Nearly the bar's height (56 px); the file has 128 px, enough for HiDPI */
  width: 44px;
  height: 44px;
  display: block;
}

.wordmark {
  font-weight: 700;
  font-size: 16px;
  letter-spacing: 0.22em;
  color: var(--text);
  white-space: nowrap;
}

.wordmark .accent {
  color: var(--accent);
}

.navs {
  display: flex;
  gap: 8px;
  min-width: 0;
}

.tabs {
  display: flex;
  gap: 2px;
  background: var(--bg-base);
  border-radius: 6px;
  padding: 3px;
}

.tab {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 14px;
  border-radius: 4px;
  font-weight: 600;
  font-size: 14px;
  color: var(--text-2);
  white-space: nowrap;
}

.tab:hover {
  color: var(--text);
  text-decoration: none;
}

.tab-divider {
  flex-shrink: 0;
  align-self: center;
  width: 1px;
  height: 20px;
  margin: 0 4px;
  background: var(--border);
}

/* The history button is a link (a route), looking like the icon buttons next to it */
.link-btn {
  text-decoration: none;
}

.link-btn.active {
  border-color: var(--accent);
  color: var(--accent);
}

/* A privilege's feature: a route as an outline button; on its page in the accent (same border width, no jump) */
.support {
  text-decoration: none;
}

.support.active {
  border-color: var(--accent);
  color: var(--accent);
}

.tab.active {
  background: var(--accent);
  color: var(--accent-text);
}

.user {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  height: var(--h-chip);
  padding: 0 10px 0 4px;
}

.avatar {
  width: 28px;
  height: 28px;
  border-radius: 50%;
  display: block;
}

.name {
  font-weight: 600;
  font-size: 14px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* The frameless window's bar also carries the window buttons: the wordmark gives way before the bar has to wrap */
@media (max-width: 1400px) {
  .topbar.framed {
    gap: 12px;
  }

  .topbar.framed .wordmark {
    display: none;
  }

  .topbar.framed .tab {
    padding: 6px 10px;
  }
}

/* Narrow screens: the tab bars get a row of their own (the data views scrolling sideways if needed) */
@media (max-width: 900px) {
  .navs {
    order: 10;
    flex-basis: 100%;
    margin-bottom: 8px;
  }

  .navs .tabs:nth-child(2) {
    min-width: 0;
    overflow-x: auto;
  }
}

/* Phones: the wordmark and the name give way */
@media (max-width: 640px) {
  .topbar {
    gap: 10px;
    padding: 0 12px;
  }

  .wordmark,
  .name {
    display: none;
  }
}
</style>
