<script setup lang="ts">
// Server, API token (created in the web app's profile and pasted here) and game folder; saving
// checks the connection.
import { computed, ref } from "vue";
import { open } from "@tauri-apps/plugin-dialog";
import ConfirmDialog, { type ConfirmButton } from "../../../webapp/src/components/ConfirmDialog.vue";
import { setConfig } from "../backend";
import { t } from "../i18n";
import { config, connectError, connected, meName, refreshConnection } from "../state";
import { errorText, toast, toastError } from "../toasts";

const emit = defineEmits<{ close: [] }>();

const server = ref(config.value?.server ?? "");
const token = ref(config.value?.token ?? "");
const gameDir = ref(config.value?.gameDir ?? "");
const busy = ref(false);

const changed = computed(() => server.value.trim() !== (config.value?.server ?? "")
  || token.value.trim() !== (config.value?.token ?? "")
  || gameDir.value.trim() !== (config.value?.gameDir ?? ""));
const buttons = computed<ConfirmButton[]>(() => [
  { label: t("common.close"), kind: "outline", value: "close" },
  { label: t("common.save"), kind: "primary", value: "save", icon: "check", form: "settings", disabled: !changed.value || busy.value },
]);
const status = computed(() => (connected.value ? t("conn.ok", { name: meName.value ?? "" })
  : connectError.value ? errorText(connectError.value) : t("conn.off")));

async function save() {
  if (!changed.value || busy.value) return;
  busy.value = true;
  try {
    config.value = await setConfig({ server: server.value.trim(), token: token.value.trim(), gameDir: gameDir.value.trim() });
    server.value = config.value.server;
    await refreshConnection();
    toast(t("settings.saved"));
  } catch (e) {
    toastError(e);
  } finally {
    busy.value = false;
  }
}

async function pickFolder() {
  const picked = await open({ directory: true, defaultPath: gameDir.value || undefined });
  if (typeof picked === "string") gameDir.value = picked;
}
</script>

<template>
  <ConfirmDialog :title="t('settings.title')" icon="settings" :buttons="buttons" @choose="emit('close')">
    <form id="settings" class="form single flush" @submit.prevent="save">
      <label class="field">
        {{ t("settings.server") }}
        <input v-model="server" class="input" type="url" placeholder="https://" autocomplete="off" spellcheck="false" />
      </label>
      <label class="field">
        {{ t("settings.token") }}
        <input v-model="token" class="input" type="password" autocomplete="off" spellcheck="false" />
      </label>
      <div class="field">
        {{ t("settings.gameDir") }}
        <div class="line">
          <input v-model="gameDir" class="input" type="text" autocomplete="off" spellcheck="false" />
          <button type="button" class="btn outline" @click="pickFolder">{{ t("settings.pick") }}</button>
        </div>
      </div>
      <div class="status" :class="{ off: !connected }">{{ status }}</div>
    </form>
  </ConfirmDialog>
</template>

<style scoped>
.line {
  display: flex;
  align-items: center;
  gap: 8px;
}

.line .input {
  flex: 1;
  min-width: 0;
}

.status {
  min-height: 20px;
  color: var(--ok);
}

.status.off {
  color: var(--text-3);
}
</style>
