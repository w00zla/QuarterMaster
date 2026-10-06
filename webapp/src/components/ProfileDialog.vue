<script setup lang="ts">
// Your profile, opened from the avatar in the top bar: RSI handle (shown to your orgs) and the web
// app's language (saved at once).
import { computed, ref, watch } from "vue";
import { t } from "../i18n";
import { me, saveProfile } from "../session";
import { toast, toastError } from "../toasts";
import ConfirmDialog, { type ConfirmButton } from "./ConfirmDialog.vue";
import LangSelect from "./LangSelect.vue";

const emit = defineEmits<{ close: [] }>();

const HANDLE = /^[A-Za-z0-9_-]{3,60}$/;

const handle = ref(me.value?.rsiHandle ?? "");
const busy = ref(false);
// Server changes replace the field only while it holds no unsaved edit
watch(() => me.value?.rsiHandle, (h, old) => {
  if (handle.value.trim() === (old ?? "")) handle.value = h ?? "";
});

const trimmed = computed(() => handle.value.trim());
const valid = computed(() => trimmed.value === "" || HANDLE.test(trimmed.value));
const changed = computed(() => trimmed.value !== (me.value?.rsiHandle ?? ""));
const buttons = computed<ConfirmButton[]>(() => [
  { label: t("common.close"), kind: "outline", value: "close" },
  { label: t("common.save"), kind: "primary", value: "save", icon: "check", form: "profile", disabled: !valid.value || !changed.value || busy.value },
]);

async function save() {
  if (!valid.value || !changed.value || busy.value) return;
  busy.value = true;
  try {
    await saveProfile({ rsiHandle: trimmed.value || null });
    toast(t("profile.saved"));
  } catch (e) {
    toastError(e);
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <ConfirmDialog v-if="me" :title="me.name" :subtitle="me.username" icon="user" :buttons="buttons" @choose="emit('close')">
    <form id="profile" class="form single flush" @submit.prevent="save">
      <label class="field">
        {{ t("profile.rsi") }}
        <input v-model="handle" class="input" :class="{ invalid: !valid }" type="text" maxlength="60" autocomplete="off" spellcheck="false" />
      </label>
      <div class="field">
        {{ t("lang.title") }}
        <LangSelect variant="outline" />
      </div>
    </form>
  </ConfirmDialog>
</template>
