<script setup lang="ts">
// The app bar in the admin UI's look: wordmark, tabs, then your history, the companion app (Access
// Key, download), the user with avatar (opens the profile) and logout.
import { onMounted, onUnmounted, ref } from "vue";
import { RouterLink } from "vue-router";
import Icon, { type IconName } from "../../../adminapp/src/components/Icon.vue";
import logo from "../../../adminapp/src/assets/logo-128.png";
import { t, type Key } from "../i18n";
import { topbarHeight } from "../layout";
import { logout, me } from "../session";
import CompanionDialog from "./CompanionDialog.vue";
import ProfileDialog from "./ProfileDialog.vue";

const tabs: Array<{ to: string; label: Key; icon: IconName }> = [
  { to: "/", label: "nav.home", icon: "overview" },
  { to: "/stock", label: "nav.stock", icon: "type-crate" },
  { to: "/refinery", label: "nav.refinery", icon: "drop" },
  { to: "/blueprints", label: "nav.blueprints", icon: "blueprint" },
];
// Tools, after a divider (as in the admin UI)
const toolTabs: Array<{ to: string; label: Key; icon: IconName }> = [{ to: "/crafting", label: "nav.crafting", icon: "crafter" }];

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
  <header ref="bar" class="topbar">
    <div class="brand">
      <img class="logo" :src="logo" alt="" />
      <span class="wordmark">QUARTER<span class="accent">MASTER</span></span>
    </div>
    <nav class="tabs">
      <RouterLink v-for="tab in tabs" :key="tab.to" :to="tab.to" class="tab" :class="{ active: $route.path === tab.to }">
        <Icon :name="tab.icon" :size="16" /> {{ t(tab.label) }}
      </RouterLink>
      <span class="tab-divider" />
      <RouterLink v-for="tab in toolTabs" :key="tab.to" :to="tab.to" class="tab" :class="{ active: $route.path === tab.to }">
        <Icon :name="tab.icon" :size="16" /> {{ t(tab.label) }}
      </RouterLink>
    </nav>
    <div class="spacer" />
    <RouterLink to="/history" class="btn small outline link-btn" :class="{ active: $route.path === '/history' }">
      <Icon name="history" :size="14" /> {{ t("nav.history") }}
    </RouterLink>
    <button class="btn small outline" type="button" @click="companionOpen = true"><Icon name="desktop" :size="14" /> {{ t("companion.open") }}</button>
    <CompanionDialog v-if="companionOpen" @close="companionOpen = false" />
    <span class="tab-divider" />
    <button v-if="me" type="button" class="user" :title="t('profile.open')" @click="profileOpen = true">
      <img class="avatar" :src="me.avatarUrl" alt="" />
      <span class="name">{{ me.name }}</span>
    </button>
    <ProfileDialog v-if="profileOpen" @close="profileOpen = false" />
    <button class="icon-btn" type="button" :title="t('user.logout')" @click="logout"><Icon name="log-out" :size="15" /></button>
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

/* The history button is a link (a route), looking like the buttons next to it */
.link-btn {
  text-decoration: none;
}

.link-btn.active {
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
  border: none;
  border-radius: var(--radius-control);
  background: transparent;
  color: inherit;
  font-family: inherit;
  cursor: pointer;
}

.user:hover {
  background: var(--bg-surface-2);
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

/* Narrow screens: the tabs get a row of their own (scrolling sideways if needed) */
@media (max-width: 900px) {
  .tabs {
    order: 10;
    flex-basis: 100%;
    overflow-x: auto;
    margin-bottom: 8px;
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
