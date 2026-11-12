<script setup lang="ts">
// Your profile, opened from the avatar in the top bar: RSI handle (shown to your orgs) and the web
// app's language; both saved with Save.
import { computed, ref, watch } from "vue";
import { t } from "../i18n";
import { me, saveProfile } from "../session";
import { toast, toastError } from "../toasts";
import ConfirmDialog, { type ConfirmButton } from "./ConfirmDialog.vue";
import LangSelect from "./LangSelect.vue";

const emit = defineEmits<{ close: [] }>();

const HANDLE = /^[A-Za-z0-9_-]{3,60}$/;

const handle = ref(me.value?.rsiHandle ?? "");
// "auto" = follow the browser
const lang = ref<string>(me.value?.langOverride ?? "auto");
const busy = ref(false);
// Server changes replace a field only while it holds no unsaved edit
watch(() => me.value?.rsiHandle, (h, old) => {
  if (handle.value.trim() === (old ?? "")) handle.value = h ?? "";
});
watch(() => me.value?.langOverride, (l, old) => {
  if (lang.value === (old ?? "auto")) lang.value = l ?? "auto";
});

const trimmed = computed(() => handle.value.trim());
const valid = computed(() => trimmed.value === "" || HANDLE.test(trimmed.value));
const handleChanged = computed(() => trimmed.value !== (me.value?.rsiHandle ?? ""));
const langChanged = computed(() => lang.value !== (me.value?.langOverride ?? "auto"));
const changed = computed(() => handleChanged.value || langChanged.value);
const buttons = computed<ConfirmButton[]>(() => [
  { label: t("common.close"), kind: "outline", value: "close" },
  { label: t("common.save"), kind: "primary", value: "save", icon: "check", form: "profile", disabled: !valid.value || !changed.value || busy.value },
]);

async function save() {
  if (!valid.value || !changed.value || busy.value) return;
  busy.value = true;
  try {
    await saveProfile({
      ...(handleChanged.value ? { rsiHandle: trimmed.value || null } : {}),
      ...(langChanged.value ? { langOverride: lang.value === "de" || lang.value === "en" ? lang.value : null } : {}),
    });
    toast(t("profile.saved"));
  } catch (e) {
    toastError(e);
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <!-- name and username are only null without a Discord profile (the singleuser variant, which has no profile dialog) -->
  <ConfirmDialog v-if="me" :title="me.name ?? ''" :subtitle="me.username ?? undefined" icon="user" :buttons="buttons" @choose="emit('close')">
    <form id="profile" class="form single flush" @submit.prevent="save">
      <label class="field">
        {{ t("profile.rsi") }}
        <input v-model="handle" class="input" :class="{ invalid: !valid }" type="text" maxlength="60" autocomplete="off" spellcheck="false" />
      </label>
      <div class="field">
        {{ t("lang.title") }}
        <LangSelect v-model="lang" variant="outline" />
      </div>
    </form>
  </ConfirmDialog>
</template>
