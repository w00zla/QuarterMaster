<script setup lang="ts">
// The language override (Auto = follow the browser), saved on the server.
import { computed } from "vue";
import Dropdown from "./Dropdown.vue";
import { t } from "../i18n";
import { me, saveProfile } from "../session";
import { toastError } from "../toasts";

defineProps<{ variant?: "chip" | "mono" | "outline" }>();

const options = computed(() => [
  { value: "auto", label: t("lang.auto") },
  { value: "de", label: "Deutsch" },
  { value: "en", label: "English" },
]);
const value = computed(() => me.value?.langOverride ?? "auto");

async function set(v: string) {
  if (v === value.value) return;
  try {
    await saveProfile({ langOverride: v === "de" || v === "en" ? v : null });
  } catch (e) {
    toastError(e);
  }
}
</script>

<template>
  <Dropdown :model-value="value" :variant="variant ?? 'chip'" :options="options" :title="t('lang.title')" @update:model-value="set" />
</template>
