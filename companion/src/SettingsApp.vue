<script setup lang="ts">
// The connection (the online server or the Quartermaster app on this PC), the online server's address (the production
// server unless changed; an emptied field is it again) and the API token (created in the web
// app's Companion dialog and pasted here; both not needed for the local app: disabled then), game folder (in the
// local mode the paired app's, shown disabled, when it has one), the UI
// language, the switch "Automatic updates" (the channel is the update dialog's); the screen scan group: the automatic tab switch (overlay.ts), then the OCR on the GPU (off
// by default) with its state as a tag and a dim note below (greyed out, off, when it cannot run there:
// gpuStatus, event "ocr-gpu"); saving checks the connection and reloads the log state (the path may have changed).
// Two columns keep the window low: the app and Star Citizen at the left, the scan and its overlay at the right. The overlay group
// (Windows only): the transparency of both overlays (a slider); the scan overlay's position (six icon-only buttons on a drawn
// monitor) and display (compact or thumbnails); the radar signature's overlay, its side next to the number (four icon-only buttons
// around a drawn plate) and whether the scan overlay stays shown in the signature scan; the hotkeys (overlay on/off, overlay view,
// scan mode), saved (on/off is the scan row's toggle and the hotkey). In the foot at the left, secondary for the user: the debug window (opening it closes this
// window).
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
import { fitSettingsWindow, getPaired, gpuStatus, openDebugWindow, setConfig, type GpuStatus, type OverlayPosition, type SignaturePosition } from "./backend";
import type { OverlayDisplay } from "./overlayLayout";
import { t } from "./i18n";
import { connectionOf, otherServer } from "./connection";
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
const autoUpdate = ref(true);
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
const hotkeyScanMode = ref("");
const transparency = ref(18);
const signaturePosition = ref<SignaturePosition>("below");
const scanOverlayInSignature = ref(true);
const busy = ref(false);
// The online server's address; left empty it is the production server again (the Rust side fills it in)
const server = ref("");
const DEFAULT_SERVER = "https://quartermaster.w00z.net";

// The fields from the loaded config
function fill() {
  const c = config.value;
  connection.value = connectionOf(c);
  server.value = c?.server ?? "";
  token.value = c?.token ?? "";
  gameDir.value = c?.gameDir ?? "";
  language.value = c?.language ?? "";
  autoTab.value = c?.autoTab ?? true;
  autoUpdate.value = c?.autoUpdate ?? true;
  gpu.value = c?.gpu ?? false;
  overlayPosition.value = c?.overlayPosition ?? "top-left";
  overlayDisplay.value = c?.overlayDisplay ?? "thumbs";
  hotkeyOverlay.value = c?.hotkeyOverlay ?? "";
  hotkeyMode.value = c?.hotkeyMode ?? "";
  hotkeyScanMode.value = c?.hotkeyScanMode ?? "";
  transparency.value = c?.overlayTransparency ?? 18;
  signaturePosition.value = c?.signaturePosition ?? "below";
  scanOverlayInSignature.value = c?.scanOverlayInSignature ?? true;
}

let unlisten: (() => void) | null = null;
onMounted(async () => {
  window.addEventListener("keydown", onKey);
  try {
    unlisten = await listen<GpuStatus>("ocr-gpu", (e) => (gpuState.value = e.payload.state));
    await loadConfig();
    paired.value = await getPaired();
    fill();
    gpuState.value = (await gpuStatus()).state;
  } catch (e) {
    toastError(e);
  }
  // The window's height is what the content takes (the overlay group exists on Windows only); it shows then
  ready.value = true;
  await nextTick();
  // With the fonts in: a fallback font wraps the texts differently and the window would get too high
  try {
    await document.fonts.ready;
  } catch { /* measured with the fonts it has */ }
  fit();
  // And whenever the content's height changes later, so no empty area stays below the foot
  if (root.value) {
    observer = new ResizeObserver(fit);
    observer.observe(root.value);
  }
});
let observer: ResizeObserver | null = null;
let fitted = 0;
function fit() {
  if (!root.value) return;
  const height = Math.ceil(root.value.getBoundingClientRect().height);
  if (!height || height === fitted) return;
  fitted = height;
  fitSettingsWindow(height).catch(toastError);
}
onUnmounted(() => {
  observer?.disconnect();
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
// The signature overlay's sides, each a button where it is around the drawn plate
const SIGNATURE_POSITIONS: SignaturePosition[] = ["above", "left", "right", "below"];

const changed = computed(() => connection.value !== connectionOf(config.value)
  || server.value.trim() !== (config.value?.server ?? "")
  || token.value.trim() !== (config.value?.token ?? "")
  || gameDir.value.trim() !== (config.value?.gameDir ?? "")
  || language.value !== (config.value?.language ?? "")
  || autoTab.value !== (config.value?.autoTab ?? true)
  || autoUpdate.value !== (config.value?.autoUpdate ?? true)
  || gpu.value !== (config.value?.gpu ?? false)
  || overlayPosition.value !== config.value?.overlayPosition
  || overlayDisplay.value !== (config.value?.overlayDisplay ?? "thumbs")
  || hotkeyOverlay.value !== config.value?.hotkeyOverlay
  || hotkeyMode.value !== config.value?.hotkeyMode
  || hotkeyScanMode.value !== (config.value?.hotkeyScanMode ?? "")
  || transparency.value !== (config.value?.overlayTransparency ?? 18)
  || signaturePosition.value !== (config.value?.signaturePosition ?? "below")
  || scanOverlayInSignature.value !== (config.value?.scanOverlayInSignature ?? true));

// Another connection or online address: the app never switches servers while running, the save restarts it (Rust
// `set_config`), and the button says so. An emptied address is the production server, as the Rust side stores it.
const restarts = computed(() => otherServer(config.value, { connection: connection.value, server: server.value.trim() || DEFAULT_SERVER }));

async function save() {
  if (!changed.value || busy.value) return;
  busy.value = true;
  try {
    applyConfig(await setConfig({
      connection: local.value ? "local" : "online",
      server: server.value.trim(),
      token: token.value.trim(),
      gameDir: gameDir.value.trim(),
      language: language.value,
      overlayPosition: overlayPosition.value,
      overlayDisplay: overlayDisplay.value,
      hotkeyOverlay: hotkeyOverlay.value,
      hotkeyMode: hotkeyMode.value,
      hotkeyScanMode: hotkeyScanMode.value,
      overlayTransparency: transparency.value,
      signaturePosition: signaturePosition.value,
      scanOverlayInSignature: scanOverlayInSignature.value,
      autoTab: autoTab.value,
      autoUpdate: autoUpdate.value,
      // Not this window's to change (the update dialog's); the Rust side keeps the stored one
      updateChannel: config.value?.updateChannel ?? "",
      gpu: gpu.value,
    }));
    // Not reached when the save restarts the app (`restarts`). This webview's own connection state (the paired app's
    // folder shown above); the main window re-checks on "config-changed" (App.vue)
    await refreshConnection();
    // As saved (an emptied server field holds the production server again)
    server.value = config.value?.server ?? "";
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
    <!-- Two columns, so the window stays low: the app and the game at the left, the scan and its overlay at the right -->
    <form id="settings" class="cols" @submit.prevent="save">
      <div class="settings-groups">
      <section class="settings-group">
        <div class="settings-group-head"><Icon name="settings" :size="14" /><span class="settings-group-title">{{ t("settings.app") }}</span></div>
        <div class="line between">
          <span class="label">{{ t("settings.connection") }}</span>
          <Dropdown v-model="connection" class="connection-pick" :options="connectionOptions" variant="outline" />
        </div>
        <!-- Server and key stay in place for the local app, which needs neither: disabled, nothing moves -->
        <label class="field">
          {{ t("settings.server") }}
          <input v-model="server" class="input" type="text" autocomplete="off" spellcheck="false" :placeholder="DEFAULT_SERVER" :disabled="local" />
        </label>
        <label class="field">
          {{ t("settings.token") }}
          <input v-model="token" class="input" type="password" autocomplete="off" spellcheck="false" :disabled="local" />
        </label>
        <div class="line between">
          <span class="label">{{ t("settings.language") }}</span>
          <Dropdown v-model="language" :options="languageOptions" variant="outline" />
        </div>
        <label class="line between">
          <span class="label">{{ t("settings.autoUpdate") }}</span>
          <input v-model="autoUpdate" class="switch" type="checkbox" />
        </label>
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
      </div>
      <div class="settings-groups">
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
      <section v-if="isWindows" class="settings-group">
        <div class="settings-group-head"><Icon name="desktop" :size="14" /><span class="settings-group-title">{{ t("settings.overlay") }}</span></div>
        <label class="line between">
          <span class="label">{{ t("settings.transparency") }}</span>
          <span class="line">
            <input v-model.number="transparency" class="slider" type="range" min="0" max="80" step="5" />
            <span class="num pct">{{ transparency }} %</span>
          </span>
        </label>
        <div class="sub-title">{{ t("settings.scanOverlay") }}</div>
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
        <div class="sub-title">{{ t("settings.signatureOverlay") }}</div>
        <div class="line between">
          <span class="label">{{ t("settings.signaturePosition") }}</span>
          <!-- The signature's plate with the four sides the overlay can sit on -->
          <div class="plate-sides">
            <span class="plate" aria-hidden="true"><Icon name="locate" :size="10" />3,600</span>
            <Tooltip v-for="p in SIGNATURE_POSITIONS" :key="p" :text="t(`signature.pos.${p}`)">
              <button type="button" class="place side" :class="[p, { active: signaturePosition === p }]" :aria-label="t(`signature.pos.${p}`)" :aria-pressed="signaturePosition === p" @click="signaturePosition = p" />
            </Tooltip>
          </div>
        </div>
        <label class="line between">
          <span class="label">{{ t("settings.scanOverlayInSignature") }}</span>
          <input v-model="scanOverlayInSignature" class="switch" type="checkbox" />
        </label>
        <div class="sub-title">{{ t("settings.hotkeys") }}</div>
        <div class="line between">
          <span class="label">{{ t("settings.hotkeyOverlay") }}</span>
          <HotkeyInput v-model="hotkeyOverlay" class="hotkey-field" />
        </div>
        <div class="line between">
          <span class="label">{{ t("settings.hotkeyMode") }}</span>
          <HotkeyInput v-model="hotkeyMode" class="hotkey-field" />
        </div>
        <div class="line between">
          <span class="label">{{ t("settings.hotkeyScanMode") }}</span>
          <HotkeyInput v-model="hotkeyScanMode" class="hotkey-field" />
        </div>
      </section>
      </div>
    </form>
    </div>
    <div class="foot">
      <!-- Secondary for the user, at the far left: the debug window -->
      <Tooltip :text="t('settings.debugHint')">
        <button type="button" class="btn small outline" @click="openDebug">
          <Icon name="log" :size="12" /> {{ t("debug.open") }}
        </button>
      </Tooltip>
      <span class="spacer" />
      <button type="button" class="btn outline" @click="close">{{ t("common.close") }}</button>
      <!-- Both labels lie in one cell: the button keeps the longer one's width whichever shows -->
      <button type="submit" form="settings" class="btn primary save" :disabled="!changed || busy">
        <span :class="{ off: restarts }" :aria-hidden="restarts"><Icon name="check" :size="14" /> {{ t("common.save") }}</span>
        <span :class="{ off: !restarts }" :aria-hidden="!restarts"><Icon name="check" :size="14" /> {{ t("settings.saveRestart") }}</span>
      </button>
    </div>
  </div>
  <Toasts />
</template>

<style scoped>
/* The window's content, as the dialog was (ConfirmDialog.vue's head, body and foot); the window is as high as it */
/* Two columns of groups, each as wide as the other, starting at the top */
.cols {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  gap: 14px;
  align-items: start;
}

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

/* Save: its two labels (plain, and "… and restart" for another server) share one grid cell */
.foot .btn.save {
  display: grid;
}

.btn.save > span {
  grid-area: 1 / 1;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 7px;
}

.btn.save > .off {
  visibility: hidden;
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

/* A part of the overlay group: a small caption over its rows */
.sub-title {
  margin-top: 4px;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: var(--text-2);
}

/* The transparency: a slider and its value in a fixed width (the row keeps its layout while dragging) */
.slider {
  width: 140px;
  accent-color: var(--accent);
}

.pct {
  width: 4.5ch;
  text-align: right;
  font-size: 12px;
}

/* The signature overlay's sides around a drawn plate (the game's: a pin and the number), as big as the monitor */
.plate-sides {
  position: relative;
  width: 112px;
  height: 70px;
  box-sizing: border-box;
  border: 2px solid var(--border);
  border-radius: var(--radius-control);
  background: var(--bg-base);
}

.plate {
  position: absolute;
  left: 50%;
  top: 50%;
  transform: translate(-50%, -50%);
  display: flex;
  align-items: center;
  gap: 3px;
  padding: 1px 5px;
  border-radius: 3px;
  background: color-mix(in srgb, var(--warn) 30%, transparent);
  font-size: 10px;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
}

.side {
  position: absolute;
}

.side.above {
  left: 50%;
  top: 4px;
  transform: translateX(-50%);
}

.side.below {
  left: 50%;
  bottom: 4px;
  transform: translateX(-50%);
}

.side.left {
  left: 4px;
  top: 50%;
  transform: translateY(-50%);
}

.side.right {
  right: 4px;
  top: 50%;
  transform: translateY(-50%);
}

/* As wide for either choice: the field does not change size with what is picked */
.connection-pick {
  width: 150px;
}
</style>
