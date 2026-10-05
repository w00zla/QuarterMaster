<script setup lang="ts">
// Start page: who is logged in and in which orgs (also fine without any org).
import { t } from "../i18n";
import { me } from "../session";
</script>

<template>
  <div v-if="me" class="home">
    <div class="dim">{{ t("home.welcome", { name: me.name }) }}</div>
    <div v-if="!me.rosterFresh && me.orgs.length" class="warning">{{ t("home.rosterStale") }}</div>
    <section class="panel">
      <div class="head">
        <span class="head-title">{{ t("home.orgs") }}</span>
        <span class="head-count">{{ me.orgs.length }}</span>
      </div>
      <div v-if="!me.orgs.length" class="empty-line">{{ t("home.noOrgs") }}</div>
      <div v-for="o in me.orgs" :key="o.guildId" class="org">
        <span class="org-name">{{ o.name }}</span>
        <span class="faint">{{ o.displayName }}</span>
        <span class="spacer" />
        <span class="role" :class="{ officer: o.officer }">{{ t(o.officer ? "home.officer" : "home.member") }}</span>
      </div>
    </section>
  </div>
</template>

<style scoped>
.home {
  display: flex;
  flex-direction: column;
  gap: 12px;
  max-width: 720px;
}

.org {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 16px;
  border-bottom: 1px solid var(--border-dim);
}

.org:last-child {
  border-bottom: none;
}

.org-name {
  font-weight: 600;
}

.role {
  font-size: 12px;
  color: var(--text-2);
}

.role.officer {
  color: var(--accent);
}
</style>
