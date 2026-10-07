<script setup lang="ts">
// The language override picker (Auto = follow the browser); the caller saves it.
import { computed } from "vue";
import Dropdown from "./Dropdown.vue";
import { t } from "../i18n";

defineProps<{ variant?: "chip" | "mono" | "outline" }>();
const model = defineModel<string>({ required: true });

const options = computed(() => [
  { value: "auto", label: t("lang.auto") },
  { value: "de", label: "Deutsch" },
  { value: "en", label: "English" },
]);
</script>

<template>
  <Dropdown v-model="model" :variant="variant ?? 'chip'" :options="options" :title="t('lang.title')" />
</template>
