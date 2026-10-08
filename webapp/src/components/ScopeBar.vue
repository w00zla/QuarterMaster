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
// The big scope switch above a list view: personal, each of your orgs, with `all` both at once.
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
      <Icon name="user" :size="16" /> {{ t("stock.personal") }}
    </button>
    <button v-for="o in me?.orgs ?? []" :key="o.guildId" type="button" class="scope" :class="{ active: scope === o.guildId }" @click="scope = o.guildId">
      <Icon name="users" :size="16" /> {{ o.name }}
    </button>
    <button v-if="all" type="button" class="scope all" :class="{ active: scope === 'all' }" @click="scope = 'all'">
      <Icon name="list" :size="16" /> {{ t("scope.all") }}
    </button>
  </div>
</template>

<style scoped>
/* "All" sits apart at the right edge */
.all {
  margin-left: auto;
}
</style>
