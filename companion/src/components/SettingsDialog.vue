<script setup lang="ts">
// API token (created in the web app's Companion dialog and pasted here), game folder, the UI
// language; the screen scan group: the automatic tab switch (overlay.ts), then the OCR on the GPU (off
// by default) with its state as a tag and a dim note below (greyed out, off, when it cannot run there:
// gpuStatus, event "ocr-gpu"); saving checks the connection and reloads the log state (the path may have changed). The
// server is fixed (only the config file changes it). The scan overlay group (Windows only):
// position (six icon-only buttons on a drawn monitor), display (compact or thumbnails) and hotkeys, saved (on/off is the scan row's
// toggle and the hotkey). In the head, secondary for the user: the debug window (opening it closes the
// dialog), small left of it the app's version.
import { computed, onMounted, onUnmounted, ref } from "vue";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import Dropdown from "./Dropdown.vue";
import Icon from "./Icon.vue";
import Tooltip from "./Tooltip.vue";
import ConfirmDialog, { type ConfirmButton } from "./ConfirmDialog.vue";
import { appInfo, gpuStatus, openDebugWindow, setConfig, type GpuStatus, type OverlayPosition } from "../backend";
import type { OverlayDisplay } from "../overlayLayout";
import { t } from "../i18n";
import { applyConfig, config, loadLog, refreshConnection } from "../state";
import { errorText, toast, toastError } from "../toasts";
import HotkeyInput from "./HotkeyInput.vue";

const emit = defineEmits<{ close: [] }>();

const token = ref(config.value?.token ?? "");
const gameDir = ref(config.value?.gameDir ?? "");
const language = ref(config.value?.language ?? "");
const autoTab = ref(config.value?.autoTab ?? true);
const gpu = ref(config.value?.gpu ?? false);
// Until the Rust side answered: as if it can
const gpuState = ref<GpuStatus["state"]>("ready");
const gpuOk = computed(() => gpuState.value === "ready");
// The state at a glance (the switch as set, before saving too): on the GPU, on the CPU, not possible
const gpuTag = computed(() => {
  if (gpuState.value === "missing") return { cls: "warn", text: t("settings.gpuMissing") };
  if (gpuState.value === "failed") return { cls: "err", text: t("settings.gpuFailed") };
  return gpu.value ? { cls: "ok", text: t("settings.gpuOn") } : { cls: "", text: t("settings.gpuCpu") };
});
const overlayPosition = ref<OverlayPosition>(config.value?.overlayPosition ?? "top-left");
const overlayDisplay = ref<OverlayDisplay>(config.value?.overlayDisplay ?? "thumbs");
const hotkeyOverlay = ref(config.value?.hotkeyOverlay ?? "");
const hotkeyMode = ref(config.value?.hotkeyMode ?? "");
const busy = ref(false);
const version = ref("");
let unlisten: (() => void) | null = null;
onMounted(async () => {
  try {
    unlisten = await listen<GpuStatus>("ocr-gpu", (e) => (gpuState.value = e.payload.state));
    version.value = (await appInfo()).version;
    gpuState.value = (await gpuStatus()).state;
  } catch (e) {
    toastError(e);
  }
});
onUnmounted(() => unlisten?.());
// The overlay needs the screen capture's window tracking (Windows only so far)
const isWindows = navigator.userAgent.includes("Windows");

const languageOptions = computed(() => [
  { value: "", label: t("lang.system") },
  { value: "de", label: t("lang.de") },
  { value: "en", label: t("lang.en") },
]);
const displayOptions = computed(() => [
  { value: "thumbs", label: t("overlay.display.thumbs") },
  { value: "compact", label: t("overlay.display.compact") },
]);
// The places where they are: top row, then bottom row
const POSITIONS: OverlayPosition[] = ["top-left", "top-center", "top-right", "bottom-left", "bottom-center", "bottom-right"];

const changed = computed(() => token.value.trim() !== (config.value?.token ?? "")
  || gameDir.value.trim() !== (config.value?.gameDir ?? "")
  || language.value !== (config.value?.language ?? "")
  || autoTab.value !== (config.value?.autoTab ?? true)
  || gpu.value !== (config.value?.gpu ?? false)
  || overlayPosition.value !== config.value?.overlayPosition
  || overlayDisplay.value !== (config.value?.overlayDisplay ?? "thumbs")
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
      overlayDisplay: overlayDisplay.value,
      hotkeyOverlay: hotkeyOverlay.value,
      hotkeyMode: hotkeyMode.value,
      autoTab: autoTab.value,
      gpu: gpu.value,
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

async function openDebug() {
  try {
    await openDebugWindow();
    emit("close");
  } catch (e) {
    toastError(e);
  }
}

async function pickFolder() {
  const picked = await open({ directory: true, defaultPath: gameDir.value || undefined });
  if (typeof picked === "string") gameDir.value = picked;
}
</script>

<template>
  <ConfirmDialog :title="t('settings.title')" icon="settings" :buttons="buttons" @choose="emit('close')">
    <template #head>
      <span class="version mono">{{ version && `v${version}` }}</span>
      <Tooltip :text="t('settings.debugHint')">
        <button type="button" class="btn small outline" @click="openDebug">
          <Icon name="log" :size="12" /> {{ t("debug.open") }}
        </button>
      </Tooltip>
    </template>
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
        <div class="group-title">{{ t("settings.scan") }}</div>
        <label class="line between">
          <span class="label">{{ t("settings.autoTab") }}</span>
          <input v-model="autoTab" class="switch" type="checkbox" />
        </label>
        <div class="gpu">
          <label class="line between" :class="{ off: !gpuOk }">
            <span class="line">
              <span class="label">{{ t("settings.gpu") }}</span>
              <span class="tag" :class="gpuTag.cls">{{ gpuTag.text }}</span>
            </span>
            <input class="switch" type="checkbox" :checked="gpuOk && gpu" :disabled="!gpuOk" @change="gpu = ($event.target as HTMLInputElement).checked" />
          </label>
          <span class="gpu-note">{{ t("settings.gpuNote") }}</span>
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
          <span class="label">{{ t("settings.overlayDisplay") }}</span>
          <Dropdown v-model="overlayDisplay" :options="displayOptions" variant="outline" />
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

/* The GPU acceleration: a plain row with its state tag, a dim note below; not possible here, the
   switch greyed out */
.gpu {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.gpu-note {
  font-size: 11px;
  color: var(--text-3);
}

.line.off .switch {
  opacity: 0.5;
  cursor: default;
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
  width: 112px;
  height: 63px;
  box-sizing: border-box;
  padding: 5px;
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
  width: 28px;
  height: 5px;
  border: 2px solid var(--border);
  border-top: none;
  border-radius: 0 0 var(--radius-control) var(--radius-control);
}

.place {
  display: block;
  width: 24px;
  height: 14px;
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

.hotkey-field {
  width: 200px;
}

.version {
  font-size: 11px;
  color: var(--text-2);
}
</style>
