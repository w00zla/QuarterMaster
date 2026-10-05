<script setup lang="ts">
// The app bar in the admin UI's look: wordmark, tabs, the user with avatar, language, logout.
import { RouterLink } from "vue-router";
import Dropdown from "../../../web/src/components/Dropdown.vue";
import logo from "../../../web/src/assets/logo-128.png";
import { LANGS, lang, t, type Lang } from "../i18n";
import { logout, me } from "../session";

const langOptions = LANGS.map((l) => ({ value: l, label: l }));
const setLang = (value: string) => (lang.value = value as Lang);
</script>

<template>
  <header class="topbar">
    <div class="brand">
      <img class="logo" :src="logo" alt="" />
      <span class="wordmark">QUARTER<span class="accent">MASTER</span></span>
    </div>
    <nav class="tabs">
      <RouterLink to="/" class="tab" :class="{ active: $route.path === '/' }">{{ t("nav.home") }}</RouterLink>
    </nav>
    <div class="spacer" />
    <div v-if="me" class="user" :title="me.username">
      <img class="avatar" :src="me.avatarUrl" alt="" />
      <span class="name">{{ me.name }}</span>
    </div>
    <Dropdown :model-value="lang" variant="mono" :options="langOptions" :title="t('lang.title')" @update:model-value="setLang" />
    <button class="btn small outline" type="button" @click="logout">{{ t("user.logout") }}</button>
  </header>
</template>

<style scoped>
.topbar {
  position: sticky;
  top: 0;
  z-index: 30;
  height: 56px;
  flex-shrink: 0;
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
  width: 32px;
  height: 32px;
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

.tab.active {
  background: var(--accent);
  color: var(--accent-text);
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
}

.name {
  font-weight: 600;
  font-size: 14px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* Phones: the wordmark gives way to the user */
@media (max-width: 640px) {
  .wordmark {
    display: none;
  }
}
</style>
