<script setup lang="ts">
// Start page: who is logged in and in which orgs (also fine without any org).
import { t } from "../i18n";
import { me } from "../session";
</script>

<template>
  <div v-if="me" class="home">
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
        <span v-if="!o.botPresent" class="warning" :title="t('home.botMissingHint')">{{ t("home.botMissing") }}</span>
        <span v-else-if="!o.rosterFresh" class="warning" :title="t('home.rosterStale')">{{ t("home.readOnly") }}</span>
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
