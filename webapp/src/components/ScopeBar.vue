<script lang="ts">
import { t } from "../i18n";
import { orgOf } from "../orgs";

/** The name of a scope for headings: "Personal", the org's name, "All". */
export function scopeName(scope: string): string {
  if (scope === "personal") return t("stock.personal");
  if (scope === "all") return t("scope.all");
  return orgOf(scope)?.name ?? "";
}
</script>

<script setup lang="ts">
// The scope switch above a list view (one joined bar): personal, each of your orgs, with `all` both at once.
// Shown also without any org, so every list view has the same layout. Model: "personal", a guildId
// or "all".
import Icon from "../../../adminapp/src/components/Icon.vue";
import { me } from "../session";

defineProps<{ all?: boolean }>();
const scope = defineModel<string>({ required: true });
</script>

<template>
  <div class="scope-bar">
    <button type="button" class="scope" :class="{ active: scope === 'personal' }" @click="scope = 'personal'">
      <Icon name="user" :size="14" /> {{ t("stock.personal") }}
    </button>
    <button v-for="o in me?.orgs ?? []" :key="o.guildId" type="button" class="scope" :class="{ active: scope === o.guildId }" @click="scope = o.guildId">
      <Icon name="users" :size="14" /> {{ o.name }}
    </button>
    <button v-if="all" type="button" class="scope" :class="{ active: scope === 'all' }" @click="scope = 'all'">
      <Icon name="list" :size="14" /> {{ t("scope.all") }}
    </button>
  </div>
</template>
