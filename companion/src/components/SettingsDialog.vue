<script setup lang="ts">
// API token (created in the web app's Companion dialog and pasted here), game folder and the UI
// language; saving checks the connection and reloads the log state (the path may have changed). The
// server is fixed (only the config file changes it). The scan overlay group (Windows only):
// position (six icon-only buttons on a drawn monitor) and hotkeys, saved (on/off is the scan row's
// toggle and the hotkey). Below the groups, quiet (secondary for the user): the debug window.
import { computed, ref } from "vue";
import { open } from "@tauri-apps/plugin-dialog";
import Dropdown from "../../../adminapp/src/components/Dropdown.vue";
import Icon from "../../../adminapp/src/components/Icon.vue";
import Tooltip from "../../../adminapp/src/components/Tooltip.vue";
import ConfirmDialog, { type ConfirmButton } from "../../../webapp/src/components/ConfirmDialog.vue";
import { openDebugWindow, setConfig, type OverlayPosition } from "../backend";
import { t } from "../i18n";
import { applyConfig, config, loadLog, refreshConnection } from "../state";
import { errorText, toast, toastError } from "../toasts";
import HotkeyInput from "./HotkeyInput.vue";

const emit = defineEmits<{ close: [] }>();

const token = ref(config.value?.token ?? "");
const gameDir = ref(config.value?.gameDir ?? "");
const language = ref(config.value?.language ?? "");
const overlayPosition = ref<OverlayPosition>(config.value?.overlayPosition ?? "top-left");
const hotkeyOverlay = ref(config.value?.hotkeyOverlay ?? "");
const hotkeyMode = ref(config.value?.hotkeyMode ?? "");
const busy = ref(false);
// The overlay needs the screen capture's window tracking (Windows only so far)
const isWindows = navigator.userAgent.includes("Windows");

const languageOptions = computed(() => [
  { value: "", label: t("lang.system") },
  { value: "de", label: t("lang.de") },
  { value: "en", label: t("lang.en") },
]);
// The places where they are: top row, then bottom row
const POSITIONS: OverlayPosition[] = ["top-left", "top-center", "top-right", "bottom-left", "bottom-center", "bottom-right"];

const changed = computed(() => token.value.trim() !== (config.value?.token ?? "")
  || gameDir.value.trim() !== (config.value?.gameDir ?? "")
  || language.value !== (config.value?.language ?? "")
  || overlayPosition.value !== config.value?.overlayPosition
  || hotkeyOverlay.value !== config.value?.hotkeyOverlay
  || hotkeyMode.value !== config.value?.hotkeyMode);
const buttons = computed<ConfirmButton[]>(() => [
  { label: t("common.close"), kind: "outline", value: "close" },
  { label: t("common.save"), kind: "primary", value: "save", icon: "check", form: "settings", disabled: !changed.value || busy.value },
]);

async function save() {
  if (!changed.value || busy.value) return;
  busy.value = true;
  try {
    applyConfig(await setConfig({
      server: config.value?.server ?? "",
      token: token.value.trim(),
      gameDir: gameDir.value.trim(),
      language: language.value,
      overlayPosition: overlayPosition.value,
      hotkeyOverlay: hotkeyOverlay.value,
      hotkeyMode: hotkeyMode.value,
    }));
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
        <div class="line between">
          <span class="label">{{ t("settings.language") }}</span>
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
      <section v-if="isWindows" class="group">
        <div class="group-title">{{ t("settings.overlay") }}</div>
        <div class="line between">
          <span class="label">{{ t("settings.overlayPosition") }}</span>
          <!-- A small monitor with the six places where they are on the screen -->
          <div class="monitor">
            <div class="screen">
              <Tooltip v-for="p in POSITIONS" :key="p" :text="t(`overlay.pos.${p}`)">
                <button type="button" class="place" :class="{ active: overlayPosition === p }" :aria-label="t(`overlay.pos.${p}`)" :aria-pressed="overlayPosition === p" @click="overlayPosition = p" />
              </Tooltip>
            </div>
            <div class="stand" />
          </div>
        </div>
        <div class="line between">
          <span class="label">{{ t("settings.hotkeyOverlay") }}</span>
          <HotkeyInput v-model="hotkeyOverlay" class="hotkey-field" />
        </div>
        <div class="line between">
          <span class="label">{{ t("settings.hotkeyMode") }}</span>
          <HotkeyInput v-model="hotkeyMode" class="hotkey-field" />
        </div>
      </section>
      <!-- Secondary: no tile of its own, one quiet line -->
      <div class="line debug">
        <span class="hint">{{ t("settings.debugHint") }}</span>
        <button type="button" class="btn small outline" @click="openDebugWindow().catch(toastError)">
          <Icon name="log" :size="12" /> {{ t("debug.open") }}
        </button>
      </div>
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

/* Hints quieter than the labels: smaller and dimmed */
.hint {
  font-size: 11px;
  color: var(--text-3);
}

.line .hint {
  flex: 1;
  min-width: 0;
}

/* A setting's name in a row: like a field's label above its control */
.label {
  font-size: 12px;
  font-weight: 400;
  color: var(--text-2);
}

/* A setting on the left, its control pushed to the right edge (as in BindSight) */
.line.between {
  justify-content: space-between;
}

/* The overlay's places on a small monitor (16:9 with a stand): top row, bottom row, each place an
   icon-only button shaped like the overlay's tile */
.monitor {
  display: flex;
  flex-direction: column;
  align-items: center;
}

.screen {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  align-content: space-between;
  justify-items: center;
  width: 176px;
  height: 99px;
  box-sizing: border-box;
  padding: 7px;
  border: 2px solid var(--border);
  border-radius: var(--radius-control);
  background: var(--bg-base);
}

.screen > :nth-child(3n + 1) {
  justify-self: start;
}

.screen > :nth-child(3n) {
  justify-self: end;
}

.stand {
  width: 44px;
  height: 7px;
  border: 2px solid var(--border);
  border-top: none;
  border-radius: 0 0 var(--radius-control) var(--radius-control);
}

.place {
  display: block;
  width: 30px;
  height: 18px;
  padding: 0;
  border: 1px dashed var(--border);
  border-radius: 3px;
  background: transparent;
  cursor: pointer;
}

.place:hover {
  border-color: var(--accent);
}

.place.active {
  border: 1px solid var(--accent);
  background: color-mix(in srgb, var(--accent) 55%, transparent);
}

/* The debug window: secondary, a quiet line below the groups */
.line.debug {
  padding: 0 4px;
}

.hotkey-field {
  width: 200px;
}
</style>
