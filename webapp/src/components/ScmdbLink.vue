<script setup lang="ts">
// Opens the blueprint on scmdb.net (its fabricator page, by the record name) in a new tab. A link
// chip, apart from the icon action buttons.
import { computed } from "vue";
import Icon from "../../../adminapp/src/components/Icon.vue";
import { t } from "../i18n";

const props = defineProps<{ blueprintKey: string }>();
const href = computed(() => `https://scmdb.net/?page=fab&fab=${encodeURIComponent(props.blueprintKey)}`);
</script>

<template>
  <a class="scmdb" :href="href" target="_blank" rel="noopener noreferrer" :title="t('bp.scmdb')" @click.stop>
    <Icon name="external" :size="11" /> SCMDB
  </a>
</template>

<style scoped>
/* As high as the chips next to it; accent instead of the chips' grey */
.scmdb {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 20px;
  padding: 0 7px;
  border: 1px solid color-mix(in srgb, var(--accent) 60%, transparent);
  border-radius: var(--radius-control);
  color: var(--accent);
  font-size: 11px;
  font-weight: 600;
  text-decoration: none;
  white-space: nowrap;
}

.scmdb:hover {
  border-color: var(--accent);
  background: color-mix(in srgb, var(--accent) 12%, transparent);
}
</style>
