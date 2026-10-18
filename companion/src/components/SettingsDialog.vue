<script setup lang="ts">
// API token (created in the web app's Companion dialog and pasted here), game folder and the UI
// language; saving checks the connection and reloads the log state (the path may have changed). The
// server is fixed (only the config file changes it). The diagnostics group opens the debug window.
import { computed, ref } from "vue";
import { open } from "@tauri-apps/plugin-dialog";
import Dropdown from "../../../adminapp/src/components/Dropdown.vue";
import ConfirmDialog, { type ConfirmButton } from "../../../webapp/src/components/ConfirmDialog.vue";
import { openDebugWindow, setConfig } from "../backend";
import { t } from "../i18n";
import { applyConfig, config, loadLog, refreshConnection } from "../state";
import { errorText, toast, toastError } from "../toasts";

const emit = defineEmits<{ close: [] }>();

const token = ref(config.value?.token ?? "");
const gameDir = ref(config.value?.gameDir ?? "");
const language = ref(config.value?.language ?? "");
const busy = ref(false);

const languageOptions = computed(() => [
  { value: "", label: t("lang.system") },
  { value: "de", label: t("lang.de") },
  { value: "en", label: t("lang.en") },
]);

const changed = computed(() => token.value.trim() !== (config.value?.token ?? "")
  || gameDir.value.trim() !== (config.value?.gameDir ?? "")
  || language.value !== (config.value?.language ?? ""));
const buttons = computed<ConfirmButton[]>(() => [
  { label: t("common.close"), kind: "outline", value: "close" },
  { label: t("common.save"), kind: "primary", value: "save", icon: "check", form: "settings", disabled: !changed.value || busy.value },
]);

async function save() {
  if (!changed.value || busy.value) return;
  busy.value = true;
  try {
    applyConfig(await setConfig({ server: config.value?.server ?? "", token: token.value.trim(), gameDir: gameDir.value.trim(), language: language.value }));
    await Promise.all([refreshConnection(), loadLog()]);
    toast(t("settings.saved"));
  } catch (e) {
    // The save itself failed
    toast(errorText(e), "error");
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
    <form id="settings" class="form single flush groups" @submit.prevent="save">
      <section class="group">
        <div class="group-title">{{ t("settings.app") }}</div>
        <label class="field">
          {{ t("settings.token") }}
          <input v-model="token" class="input" type="password" autocomplete="off" spellcheck="false" />
        </label>
        <div class="field">
          {{ t("settings.language") }}
          <Dropdown v-model="language" :options="languageOptions" variant="outline" />
        </div>
      </section>
      <section class="group">
        <div class="group-title">Star Citizen</div>
        <div class="field">
          {{ t("settings.gameDir") }}
          <div class="line">
            <input v-model="gameDir" class="input" type="text" autocomplete="off" spellcheck="false" />
            <button type="button" class="btn outline" @click="pickFolder">{{ t("settings.pick") }}</button>
          </div>
        </div>
      </section>
      <section class="group">
        <div class="group-title">{{ t("settings.diagnostics") }}</div>
        <div class="line">
          <span class="hint">{{ t("settings.debugHint") }}</span>
          <button type="button" class="btn outline" @click="openDebugWindow().catch(toastError)">{{ t("debug.open") }}</button>
        </div>
      </section>
    </form>
  </ConfirmDialog>
</template>

<style scoped>
/* Room for the group titles straddling the tiles' top edges */
.groups {
  gap: 22px;
  padding-top: 8px;
}

/* Each group is a tile with its title on the top edge, like a fieldset legend (as in BindSight) */
.group {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 18px 16px 14px;
  background: var(--bg-base);
  border: 1px solid var(--border-dim);
  border-radius: var(--radius-panel);
}

.group-title {
  position: absolute;
  top: 0;
  left: 12px;
  transform: translateY(-50%);
  padding: 0 8px;
  /* The dialog's own ground, to break the tile's top border under the label */
  background: var(--bg-surface);
  color: var(--text-2);
  font-size: 13px;
  font-weight: 600;
}

.line {
  display: flex;
  align-items: center;
  gap: 8px;
}

.line .input {
  flex: 1;
  min-width: 0;
}

.line .hint {
  flex: 1;
  min-width: 0;
  font-size: 12px;
  color: var(--text-2);
}
</style>
