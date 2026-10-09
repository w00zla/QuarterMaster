<script setup lang="ts">
// Whether the stock covers a crafting need: "covered", "missing 2.5 SCU", or a dash while the stock loads.
import type { Coverage } from "../craftingStock";
import { qty } from "../format";
import { t } from "../i18n";

defineProps<{ coverage: Coverage; loading: boolean }>();
</script>

<template>
  <span v-if="loading" class="tag">—</span>
  <span v-else-if="coverage.covered" class="tag ok">{{ t("crafting.covered") }}</span>
  <span v-else class="tag err">{{ t("crafting.lacking", { n: qty(coverage.missing, coverage.unit) }) }}</span>
</template>
