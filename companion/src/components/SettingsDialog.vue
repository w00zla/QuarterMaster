<script setup lang="ts">
// Server, API token (created in the web app's profile and pasted here) and game folder; saving
// checks the connection and reloads the log state (the path may have changed).
import { computed, ref } from "vue";
import { open } from "@tauri-apps/plugin-dialog";
import Icon from "../../../adminapp/src/components/Icon.vue";
import ConfirmDialog, { type ConfirmButton } from "../../../webapp/src/components/ConfirmDialog.vue";
import { setConfig } from "../backend";
import { t } from "../i18n";
import { config, connectError, connected, connectionText, loadLog, refreshConnection } from "../state";
import { errorText, toast } from "../toasts";

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

async function save() {
  if (!changed.value || busy.value) return;
  busy.value = true;
  try {
    config.value = await setConfig({ server: server.value.trim(), token: token.value.trim(), gameDir: gameDir.value.trim() });
    server.value = config.value.server;
    await Promise.all([refreshConnection(), loadLog()]);
    toast(t("settings.saved"));
  } catch (e) {
    // Also the connection codes (invalid server address): the save itself failed
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
        <div class="group-title">{{ t("settings.connection") }}</div>
        <label class="field">
          {{ t("settings.server") }}
          <input v-model="server" class="input" type="url" placeholder="https://" autocomplete="off" spellcheck="false" />
          <span class="status" :class="connected ? 'ok' : connectError ? 'err' : 'off'">
            <Icon :name="connected ? 'user' : 'warning'" :size="14" />
            {{ connectionText }}
          </span>
        </label>
        <label class="field">
          {{ t("settings.token") }}
          <input v-model="token" class="input" type="password" autocomplete="off" spellcheck="false" />
        </label>
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

/* The connection state right below the server, tinted like the top bar's chip */
.status {
  display: flex;
  align-items: center;
  gap: 6px;
  min-height: 28px;
  padding: 4px 10px;
  border-radius: var(--radius-control);
  background: var(--bg-surface-2);
  color: var(--text-3);
  font-size: 12px;
  font-weight: 600;
}

.status.ok {
  color: var(--ok);
  background: color-mix(in srgb, var(--ok) 12%, transparent);
}

.status.err {
  color: var(--err);
  background: color-mix(in srgb, var(--err) 12%, transparent);
}
</style>
