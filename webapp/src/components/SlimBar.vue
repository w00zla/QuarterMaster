<script setup lang="ts">
// The header across the window's full width above the side bar and the content (56 px: the narrow side bar's width): the app's
// logo and name at the left, the drag region, then the variant's controls (navigation.ts `userControls`). Online: the privileges'
// features (outline buttons, routes) and Companion (its dialog), the game version chip, a divider, the user (avatar, name), the
// profile and logout. Singleuser: the game version chip, the settings button and, in the desktop shell, the window buttons; the
// settings button opens the shell's settings window, in a plain browser it is the /settings page. It never wraps: on narrow
// screens the wordmark and the name give way, then the buttons' labels. In a plain browser the bar has no window buttons and no
// drag attributes.
import { computed, onMounted, onUnmounted, ref } from "vue";
import { RouterLink, useRoute } from "vue-router";
import Icon, { type IconName } from "../../../adminapp/src/components/Icon.vue";
import logo from "../../../adminapp/src/assets/logo-128.png";
import { capabilities, gameLabel } from "../capabilities";
import { t, type Key } from "../i18n";
import { topbarHeight } from "../layout";
import { userControls } from "../navigation";
import { logout, me } from "../session";
import { shell } from "../shell";
import CompanionDialog from "./CompanionDialog.vue";
import ProfileDialog from "./ProfileDialog.vue";
import WindowButtons from "./WindowButtons.vue";

const route = useRoute();
// The attribute's mere presence marks a drag region (not in a browser)
const drag = computed(() => (shell.available ? "" : undefined));

// Without a login there is no user, profile, logout or companion download; the settings button takes their place
const controls = computed(() => userControls(capabilities.value));
// Features (docs/webapp.md "Features and privileges"): a button left of Companion for whoever holds the privilege
const privilegeTabs: Array<{ to: string; label: Key; icon: IconName; key: string }> = [
  { to: "/feature/thumb-review", label: "nav.thumbReview", icon: "eye", key: "thumb-review.mark" },
];
const supportTabs = computed(() => privilegeTabs.filter((tab) => me.value?.privileges.includes(tab.key)));
const profileOpen = ref(false);
const companionOpen = ref(false);

// The toasts sit right below the bar (layout.ts)
const bar = ref<HTMLElement | null>(null);
const observer = new ResizeObserver(([e]) => (topbarHeight.value = e!.target.getBoundingClientRect().height));
onMounted(() => bar.value && observer.observe(bar.value));
onUnmounted(() => {
  observer.disconnect();
  topbarHeight.value = 0;
});
</script>

<template>
  <header ref="bar" class="slim" :data-tauri-drag-region="drag">
    <!-- The app's logo and name, as the companion's top bar has them -->
    <div class="brand" :data-tauri-drag-region="drag">
      <img class="logo" :src="logo" alt="" :data-tauri-drag-region="drag" />
      <span class="wordmark" :data-tauri-drag-region="drag">QUARTER<span class="accent">MASTER</span></span>
    </div>
    <span class="grow" :data-tauri-drag-region="drag" />
    <template v-if="controls.companion">
      <RouterLink v-for="tab in supportTabs" :key="tab.to" :to="tab.to" class="btn small outline support" :class="{ active: route.path === tab.to }" :title="t(tab.label)">
        <Icon :name="tab.icon" :size="14" /> <span class="btn-label">{{ t(tab.label) }}</span>
      </RouterLink>
      <button class="btn small outline" type="button" :title="t('companion.open')" @click="companionOpen = true">
        <Icon name="desktop" :size="14" /> <span class="btn-label">{{ t("companion.open") }}</span>
      </button>
      <CompanionDialog v-if="companionOpen" @close="companionOpen = false" />
    </template>
    <!-- The game version of the installed data; a fixed width, so the dash and the number take the same room -->
    <span class="ver-chip fixed" :class="{ none: !gameLabel }" :title="t('nav.gameVersion')" :data-tauri-drag-region="drag"><span class="ver-label" :data-tauri-drag-region="drag">{{ t("nav.game") }}</span>{{ gameLabel ?? "–" }}</span>
    <template v-if="controls.user && me">
      <span class="divider" />
      <span class="user">
        <img v-if="me.avatarUrl" class="avatar" :src="me.avatarUrl" alt="" />
        <span class="name">{{ me.name }}</span>
      </span>
    </template>
    <button v-if="controls.profile && me" class="icon-btn" type="button" :title="t('profile.open')" @click="profileOpen = true"><Icon name="settings" :size="15" /></button>
    <ProfileDialog v-if="profileOpen" @close="profileOpen = false" />
    <template v-if="controls.settings">
      <button v-if="shell.available" class="icon-btn" type="button" :title="t('nav.settings')" @click="shell.openSettings()"><Icon name="settings" :size="15" /></button>
      <RouterLink v-else to="/settings" class="icon-btn link-btn" :class="{ active: route.path === '/settings' }" :title="t('nav.settings')">
        <Icon name="settings" :size="15" />
      </RouterLink>
    </template>
    <button v-if="controls.logout" class="icon-btn" type="button" :title="t('user.logout')" @click="logout"><Icon name="log-out" :size="15" /></button>
    <WindowButtons />
  </header>
</template>

<style scoped>
.slim {
  position: sticky;
  top: 0;
  z-index: 30;
  /* As high as the narrow side bar is wide (and as its logo row): the corner is a square, the line below runs on */
  height: 56px;
  flex-shrink: 0;
  box-sizing: border-box;
  display: flex;
  flex-wrap: nowrap;
  align-items: center;
  gap: 12px;
  /* The logo 10 px in, as in the companion's top bar */
  padding: 0 8px 0 10px;
  /* Set apart from the content: the side bar's and the footer's ground, a line below */
  background: var(--bg-surface);
  border-bottom: 1px solid var(--border-dim);
  user-select: none;
}

.brand {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-shrink: 0;
}

.logo {
  width: 36px;
  height: 36px;
  flex-shrink: 0;
  display: block;
}

.wordmark {
  font-size: 13px;
  font-weight: 700;
  letter-spacing: 0.16em;
  white-space: nowrap;
  color: var(--text);
}

.wordmark .accent {
  color: var(--accent);
}

.grow {
  flex: 1;
  align-self: stretch;
}

.ver-chip {
  flex-shrink: 0;
}

/* The settings page's button is a link (a route), looking like the icon button */
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

.btn {
  flex-shrink: 0;
}

.divider {
  flex-shrink: 0;
  width: 1px;
  height: 20px;
  background: var(--border);
}

.user {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.avatar {
  width: 28px;
  height: 28px;
  border-radius: 50%;
  display: block;
  flex-shrink: 0;
}

.name {
  font-weight: 600;
  font-size: 14px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* The bar never wraps: the wordmark and the name give way first, then the buttons' labels (icon only, the title says what) */
@media (max-width: 900px) {
  .wordmark,
  .name {
    display: none;
  }
}

@media (max-width: 640px) {
  .btn-label {
    display: none;
  }
}
</style>
