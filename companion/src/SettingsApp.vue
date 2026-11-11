<script setup lang="ts">
// The connection (the online server or the Quartermaster app on this PC), the API token (created in the web
// app's Companion dialog and pasted here; not needed for the local app: disabled then), game folder (in the
// local mode the paired app's, shown disabled, when it has one), the UI
// language; the screen scan group: the automatic tab switch (overlay.ts), then the OCR on the GPU (off
// by default) with its state as a tag and a dim note below (greyed out, off, when it cannot run there:
// gpuStatus, event "ocr-gpu"); saving checks the connection and reloads the log state (the path may have changed). The
// server is fixed (only the config file changes it). The scan overlay group (Windows only):
// position (six icon-only buttons on a drawn monitor), display (compact or thumbnails) and hotkeys, saved (on/off is the scan row's
// toggle and the hotkey). In the foot at the left, secondary for the user: the debug window (opening it closes this
// window), next to it the app's version.
// The settings window (opened from the main window, Rust `open_settings_window`): fixed width, not resizable,
// frameless with a title bar of its own (icon, "QM Companion Settings", close), like the desktop app's settings window. This page loads config and pairing itself (its own webview), sizes the window
// to the content once filled (`fit_settings_window`, which also shows it), and after a save the main window
// hears "config-changed" and re-reads the config, the connection and the log state.
import { computed, nextTick, onMounted, onUnmounted, ref } from "vue";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open } from "@tauri-apps/plugin-dialog";
import Dropdown from "../../adminapp/src/components/Dropdown.vue";
import Icon from "../../adminapp/src/components/Icon.vue";
import Tooltip from "../../adminapp/src/components/Tooltip.vue";
import { appInfo, fitSettingsWindow, getPaired, gpuStatus, openDebugWindow, setConfig, type GpuStatus, type OverlayPosition } from "./backend";
import type { OverlayDisplay } from "./overlayLayout";
import { t } from "./i18n";
import { connectionOf } from "./connection";
import { applyConfig, config, loadConfig, paired, refreshConnection } from "./state";
import { errorText, toast, toastError } from "./toasts";
import HotkeyInput from "./components/HotkeyInput.vue";
import Toasts from "./components/Toasts.vue";
import WindowTitleBar from "./components/WindowTitleBar.vue";

// The form shows once config and pairing are loaded (its fields start from them)
const ready = ref(false);
const root = ref<HTMLElement | null>(null);
const connection = ref<string>("online");
const local = computed(() => connection.value === "local");
// The local app's game folder comes first (as paired at the last connection); null: the own setting applies
const pairedDir = computed(() => (local.value ? paired.value?.gameDir ?? null : null));
const token = ref("");
const gameDir = ref("");
const language = ref("");
const autoTab = ref(true);
const gpu = ref(false);
// Until the Rust side answered: as if it can
const gpuState = ref<GpuStatus["state"]>("ready");
const gpuOk = computed(() => gpuState.value === "ready");
// The state at a glance (the switch as set, before saving too): on the GPU, on the CPU, not possible
const gpuTag = computed(() => {
  if (gpuState.value === "missing") return { cls: "warn", text: t("settings.gpuMissing") };
  if (gpuState.value === "failed") return { cls: "err", text: t("settings.gpuFailed") };
  return gpu.value ? { cls: "ok", text: t("settings.gpuOn") } : { cls: "", text: t("settings.gpuCpu") };
});
const overlayPosition = ref<OverlayPosition>("top-left");
const overlayDisplay = ref<OverlayDisplay>("thumbs");
const hotkeyOverlay = ref("");
const hotkeyMode = ref("");
const busy = ref(false);
const version = ref("");

// The fields from the loaded config
function fill() {
  const c = config.value;
  connection.value = connectionOf(c);
  token.value = c?.token ?? "";
  gameDir.value = c?.gameDir ?? "";
  language.value = c?.language ?? "";
  autoTab.value = c?.autoTab ?? true;
  gpu.value = c?.gpu ?? false;
  overlayPosition.value = c?.overlayPosition ?? "top-left";
  overlayDisplay.value = c?.overlayDisplay ?? "thumbs";
  hotkeyOverlay.value = c?.hotkeyOverlay ?? "";
  hotkeyMode.value = c?.hotkeyMode ?? "";
}

let unlisten: (() => void) | null = null;
onMounted(async () => {
  window.addEventListener("keydown", onKey);
  try {
    unlisten = await listen<GpuStatus>("ocr-gpu", (e) => (gpuState.value = e.payload.state));
    await loadConfig();
    paired.value = await getPaired();
    fill();
    version.value = (await appInfo()).version;
    gpuState.value = (await gpuStatus()).state;
  } catch (e) {
    toastError(e);
  }
  // The window's height is what the content takes (the overlay group exists on Windows only); it shows then
  ready.value = true;
  await nextTick();
  if (root.value) await fitSettingsWindow(Math.ceil(root.value.getBoundingClientRect().height)).catch(toastError);
});
onUnmounted(() => {
  unlisten?.();
  window.removeEventListener("keydown", onKey);
});

const close = () => void getCurrentWindow().close();
// Escape closes, unless something in the page took it (a hotkey field recording, a dropdown)
function onKey(e: KeyboardEvent) {
  if (e.key === "Escape" && !e.defaultPrevented) close();
}
// The overlay needs the screen capture's window tracking (Windows only so far)
const isWindows = navigator.userAgent.includes("Windows");

const connectionOptions = computed(() => [
  { value: "online", label: t("settings.connection.online") },
  { value: "local", label: t("settings.connection.local") },
]);
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

const changed = computed(() => connection.value !== connectionOf(config.value)
  || token.value.trim() !== (config.value?.token ?? "")
  || gameDir.value.trim() !== (config.value?.gameDir ?? "")
  || language.value !== (config.value?.language ?? "")
  || autoTab.value !== (config.value?.autoTab ?? true)
  || gpu.value !== (config.value?.gpu ?? false)
  || overlayPosition.value !== config.value?.overlayPosition
  || overlayDisplay.value !== (config.value?.overlayDisplay ?? "thumbs")
  || hotkeyOverlay.value !== config.value?.hotkeyOverlay
  || hotkeyMode.value !== config.value?.hotkeyMode);

async function save() {
  if (!changed.value || busy.value) return;
  busy.value = true;
  try {
    applyConfig(await setConfig({
      connection: local.value ? "local" : "online",
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
    // This webview's own connection state (the paired app's folder shown above); the main window re-checks
    // on "config-changed" (App.vue)
    await refreshConnection();
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
    close();
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
  <div v-if="ready" ref="root" class="settings">
    <!-- The frameless window's title bar, as the desktop app's settings window has it: icon, title, close -->
    <WindowTitleBar icon="settings" :title="t('settings.windowTitle')" close-only />
    <div class="body">
    <form id="settings" class="settings-groups" @submit.prevent="save">
      <section class="settings-group">
        <div class="settings-group-head"><Icon name="settings" :size="14" /><span class="settings-group-title">{{ t("settings.app") }}</span></div>
        <div class="line between">
          <span class="label">{{ t("settings.connection") }}</span>
          <Dropdown v-model="connection" class="connection-pick" :options="connectionOptions" variant="outline" />
        </div>
        <!-- Stays in place for the local app, which needs no key: disabled, nothing moves -->
        <label class="field">
          {{ t("settings.token") }}
          <input v-model="token" class="input" type="password" autocomplete="off" spellcheck="false" :disabled="local" />
        </label>
        <div class="line between">
          <span class="label">{{ t("settings.language") }}</span>
          <Dropdown v-model="language" :options="languageOptions" variant="outline" />
        </div>
      </section>
      <section class="settings-group">
        <div class="settings-group-head"><Icon name="camera" :size="14" /><span class="settings-group-title">{{ t("settings.scan") }}</span></div>
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
      <section class="settings-group">
        <div class="settings-group-head"><Icon name="folder" :size="14" /><span class="settings-group-title">Star Citizen</span></div>
        <div class="field">
          {{ t("settings.gameDir") }}
          <div class="line">
            <!-- The paired app's folder is shown instead of the own setting (kept as it is), not editable here -->
            <input
              class="input" type="text" autocomplete="off" spellcheck="false" :value="pairedDir ?? gameDir" :disabled="pairedDir !== null"
              @input="gameDir = ($event.target as HTMLInputElement).value"
            />
            <button type="button" class="btn outline" :disabled="pairedDir !== null" @click="pickFolder">{{ t("settings.pick") }}</button>
          </div>
        </div>
      </section>
      <section v-if="isWindows" class="settings-group">
        <div class="settings-group-head"><Icon name="desktop" :size="14" /><span class="settings-group-title">{{ t("settings.overlay") }}</span></div>
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
    </div>
    <div class="foot">
      <!-- Secondary for the user, at the far left: the debug window and the app's version -->
      <Tooltip :text="t('settings.debugHint')">
        <button type="button" class="btn small outline" @click="openDebug">
          <Icon name="log" :size="12" /> {{ t("debug.open") }}
        </button>
      </Tooltip>
      <span class="version mono">{{ version && `v${version}` }}</span>
      <span class="spacer" />
      <button type="button" class="btn outline" @click="close">{{ t("common.close") }}</button>
      <button type="submit" form="settings" class="btn primary" :disabled="!changed || busy">
        <Icon name="check" :size="14" /> {{ t("common.save") }}
      </button>
    </div>
  </div>
  <Toasts />
</template>

<style scoped>
/* The window's content, as the dialog was (ConfirmDialog.vue's head, body and foot); the window is as high as it */
.settings {
  background: var(--bg-surface);
}

.foot {
  display: flex;
  align-items: center;
  padding: 16px 20px;
}

/* The buttons at the right keep the controls' height; the debug button at the left stays small */
.foot .btn:not(.small) {
  height: var(--h-control);
  font-size: 14px;
}

.spacer {
  flex: 1;
}

.body {
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding: 18px 20px;
}

.foot {
  gap: 8px;
  border-top: 1px solid var(--border-dim);
}

/* The groups: webapp/src/styles.css `.settings-group` (a tile with a head row: icon and title) */

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

/* As wide for either choice: the field does not change size with what is picked */
.connection-pick {
  width: 150px;
}

.version {
  font-size: 11px;
  color: var(--text-2);
}
</style>
