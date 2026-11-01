<script setup lang="ts">
// The admin's navigation: wordmark, the pages in groups, a toggle that folds the bar to its icons
// (remembered per browser). Status shows the number of user data check hits.
import { ref, watch } from "vue";
import { RouterLink, useRoute } from "vue-router";
import Icon, { type IconName } from "./Icon.vue";
import logo from "../assets/logo-128.png";

defineProps<{ checkHits: number }>();

const GROUPS: { label: string; items: { to: string; label: string; icon: IconName }[] }[] = [
  { label: "Operations", items: [
    { to: "/", label: "Dashboard", icon: "overview" },
    { to: "/status", label: "Status", icon: "status" },
    { to: "/activity", label: "Activity", icon: "activity" },
  ] },
  { label: "Community", items: [
    { to: "/orgs", label: "Orgs", icon: "users" },
    { to: "/users", label: "Users", icon: "user" },
    { to: "/features", label: "Features", icon: "lock" },
  ] },
  { label: "Stock", items: [
    { to: "/stock", label: "Stock", icon: "stock" },
    { to: "/refinery", label: "Refinery", icon: "drop" },
  ] },
  { label: "Catalog", items: [
    { to: "/blueprints", label: "Blueprints", icon: "blueprint" },
    { to: "/materials", label: "Materials", icon: "resource" },
    { to: "/items", label: "Items", icon: "item" },
    { to: "/mining", label: "Mining", icon: "pickaxe" },
    { to: "/texts", label: "Texts", icon: "texts" },
  ] },
  { label: "Sources", items: [
    { to: "/imports", label: "Imports", icon: "imports" },
    { to: "/uex", label: "UEX", icon: "link" },
  ] },
  { label: "Apps", items: [
    { to: "/bot", label: "Bot", icon: "bot" },
  ] },
];

const route = useRoute();
const isActive = (to: string) => (to === "/" ? route.path === "/" : route.path === to || route.path.startsWith(`${to}/`));

const KEY = "qm.nav.collapsed";
const load = () => {
  try {
    return localStorage.getItem(KEY) === "1";
  } catch {
    return false;
  }
};
const collapsed = ref(load());
watch(collapsed, (c) => {
  try {
    localStorage.setItem(KEY, c ? "1" : "0");
  } catch {
    // localStorage unavailable: the choice simply does not persist.
  }
});
</script>

<template>
  <nav class="side" :class="{ collapsed }">
    <div class="brand">
      <img class="logo" :src="logo" alt="" />
      <span v-if="!collapsed" class="wordmark">QUARTER<span class="accent">MASTER</span></span>
    </div>
    <div class="groups">
      <div v-for="g in GROUPS" :key="g.label" class="group">
        <span v-if="!collapsed" class="group-label">{{ g.label }}</span>
        <RouterLink
          v-for="i in g.items"
          :key="i.to"
          :to="i.to"
          class="item"
          :class="{ active: isActive(i.to) }"
          :title="collapsed ? i.label : undefined"
        >
          <Icon :name="i.icon" :size="16" />
          <span v-if="!collapsed" class="label">{{ i.label }}</span>
          <span v-if="i.to === '/status' && checkHits" class="badge mono">{{ checkHits }}</span>
        </RouterLink>
      </div>
    </div>
    <button type="button" class="icon-btn toggle" :title="collapsed ? 'Expand' : 'Collapse'" @click="collapsed = !collapsed">
      <Icon :name="collapsed ? 'chevron-right' : 'chevron-left'" :size="16" />
    </button>
  </nav>
</template>

<style scoped>
.side {
  width: 200px;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 10px 8px;
  background: var(--bg-surface);
  border-right: 1px solid var(--border-dim);
  overflow-y: auto;
}

.side.collapsed {
  width: 52px;
}

.brand {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 36px;
  padding: 0 2px;
}

.logo {
  /* The file has 128 px, enough for HiDPI */
  width: 32px;
  height: 32px;
  display: block;
  flex-shrink: 0;
}

.wordmark {
  font-weight: 700;
  font-size: 13px;
  letter-spacing: 0.2em;
  color: var(--text);
  white-space: nowrap;
}

/* Two-tone like BindSight's: QUARTER white, MASTER blue. */
.wordmark .accent {
  color: var(--accent);
}

.groups {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.group {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.group-label {
  padding: 0 10px 4px;
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: var(--text-3);
}

.item {
  display: flex;
  align-items: center;
  gap: 10px;
  height: 32px;
  padding: 0 10px;
  border-radius: var(--radius-control);
  font-weight: 600;
  font-size: 13px;
  color: var(--text-2);
  text-decoration: none;
  white-space: nowrap;
}

.collapsed .item {
  justify-content: center;
  padding: 0;
  position: relative;
}

.item:hover {
  background: var(--bg-surface-2);
  color: var(--text);
  text-decoration: none;
}

.item.active {
  background: var(--accent);
  color: var(--accent-text);
}

.label {
  flex: 1;
}

.badge {
  min-width: 20px;
  height: 18px;
  padding: 0 5px;
  border-radius: var(--radius-control);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 11px;
  color: var(--warn);
  background: color-mix(in srgb, var(--warn) 16%, transparent);
}

.collapsed .badge {
  position: absolute;
  top: -2px;
  right: -2px;
  min-width: 16px;
  height: 14px;
  font-size: 10px;
}

.item.active .badge {
  color: var(--accent-text);
  background: rgba(0, 0, 0, 0.18);
}

.toggle {
  align-self: flex-end;
  width: 28px;
  height: 28px;
}

.collapsed .toggle {
  align-self: center;
}
</style>
