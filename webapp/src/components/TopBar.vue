<script setup lang="ts">
// The app bar in the admin UI's look: wordmark, tabs, then the companion app (Access Key, download),
// the user with avatar, profile, your history and logout.
import { computed, onMounted, onUnmounted, ref } from "vue";
import { RouterLink } from "vue-router";
import Icon, { type IconName } from "../../../adminapp/src/components/Icon.vue";
import logo from "../../../adminapp/src/assets/logo-128.png";
import { t, type Key } from "../i18n";
import { topbarHeight } from "../layout";
import { logout, me } from "../session";
import CompanionDialog from "./CompanionDialog.vue";
import ProfileDialog from "./ProfileDialog.vue";

// The overview on its own, then the data views
const homeTab: { to: string; label: Key; icon: IconName } = { to: "/", label: "nav.home", icon: "overview" };
const tabs: Array<{ to: string; label: Key; icon: IconName }> = [
  { to: "/gear", label: "nav.components", icon: "gear" },
  { to: "/resources", label: "nav.stock", icon: "type-crate" },
  { to: "/refinery", label: "nav.refinery", icon: "drop" },
  { to: "/blueprints", label: "nav.blueprints", icon: "blueprint" },
];
// Tools, after a divider (as in the admin UI)
const toolTabs: Array<{ to: string; label: Key; icon: IconName }> = [
  { to: "/crafting", label: "nav.crafting", icon: "crafter" },
  { to: "/mining", label: "nav.mining", icon: "pickaxe" },
  { to: "/trade", label: "nav.trade", icon: "trade" },
];
// Features behind a privilege (docs/webapp.md "Privileges"): a button left of Companion, only for its holders
const privilegeTabs: Array<{ to: string; label: Key; icon: IconName; key: string }> = [
  { to: "/review/thumbs", label: "nav.thumbReview", icon: "eye", key: "thumb-review" },
];
const supportTabs = computed(() => privilegeTabs.filter((tab) => me.value?.privileges.includes(tab.key)));

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
    <!-- Three bars: the overview, the data views, the tools -->
    <div class="navs">
      <nav class="tabs">
        <RouterLink :to="homeTab.to" class="tab" :class="{ active: $route.path === homeTab.to }">
          <Icon :name="homeTab.icon" :size="16" /> {{ t(homeTab.label) }}
        </RouterLink>
      </nav>
      <nav class="tabs">
        <RouterLink v-for="tab in tabs" :key="tab.to" :to="tab.to" class="tab" :class="{ active: $route.path === tab.to }">
          <Icon :name="tab.icon" :size="16" /> {{ t(tab.label) }}
        </RouterLink>
      </nav>
      <nav class="tabs">
        <RouterLink v-for="tab in toolTabs" :key="tab.to" :to="tab.to" class="tab" :class="{ active: $route.path === tab.to }">
          <Icon :name="tab.icon" :size="16" /> {{ t(tab.label) }}
        </RouterLink>
      </nav>
    </div>
    <div class="spacer" />
    <RouterLink v-for="tab in supportTabs" :key="tab.to" :to="tab.to" class="btn small outline support" :class="{ active: $route.path === tab.to }">
      <Icon :name="tab.icon" :size="14" /> {{ t(tab.label) }}
    </RouterLink>
    <button class="btn small outline" type="button" @click="companionOpen = true"><Icon name="desktop" :size="14" /> {{ t("companion.open") }}</button>
    <CompanionDialog v-if="companionOpen" @close="companionOpen = false" />
    <span class="tab-divider" />
    <span v-if="me" class="user">
      <img class="avatar" :src="me.avatarUrl" alt="" />
      <span class="name">{{ me.name }}</span>
    </span>
    <button v-if="me" class="icon-btn" type="button" :title="t('profile.open')" @click="profileOpen = true"><Icon name="settings" :size="15" /></button>
    <ProfileDialog v-if="profileOpen" @close="profileOpen = false" />
    <RouterLink to="/history" class="icon-btn link-btn" :class="{ active: $route.path === '/history' }" :title="t('nav.history')">
      <Icon name="history" :size="15" />
    </RouterLink>
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
