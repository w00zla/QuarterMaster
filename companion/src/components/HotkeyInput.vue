<script setup lang="ts">
// A global hotkey, stored as Tauri's accelerator ("Ctrl+Shift+KeyO", the physical key's code): a
// click starts recording, the next combination is taken; Escape cancels, Backspace or Delete clears
// it, as does the × inside the field while one is set. A key needs Ctrl, Alt or Shift (a bare key
// would be taken from every app), function keys excepted. Shown with the UI language's key names
// ("Strg+Umschalt+O").
import { ref } from "vue";
import Icon from "../../../adminapp/src/components/Icon.vue";
import { langRef, t } from "../i18n";

const model = defineModel<string>({ required: true });
const recording = ref(false);

const MODIFIER_KEYS = ["Control", "Shift", "Alt", "Meta", "AltGraph"];

function onKey(e: KeyboardEvent) {
  if (!recording.value) return;
  // Not to the dialog (Escape would close it) or the form (Enter)
  e.preventDefault();
  e.stopPropagation();
  if (MODIFIER_KEYS.includes(e.key)) return;
  recording.value = false;
  if (e.key === "Escape") return;
  if (e.key === "Backspace" || e.key === "Delete") return void (model.value = "");
  const mods = [e.ctrlKey && "Ctrl", e.altKey && "Alt", e.shiftKey && "Shift"].filter((m): m is string => !!m);
  if (!mods.length && !/^F\d+$/.test(e.code)) return;
  model.value = [...mods, e.code].join("+");
}

/** "Ctrl+Shift+KeyO" as "Ctrl+Shift+O" ("Strg+Umschalt+O" in German). */
function display(accel: string): string {
  const names: Record<string, string> = langRef.value === "de" ? { Ctrl: "Strg", Shift: "Umschalt" } : {};
  return accel
    .split("+")
    .map((p) => names[p] ?? p.replace(/^Key([A-Z])$/, "$1").replace(/^Digit(\d)$/, "$1"))
    .join("+");
}
</script>

<template>
  <span class="hotkey-input">
    <button type="button" class="input hotkey" :class="{ recording, empty: !model }" @click="recording = !recording" @keydown="onKey" @blur="recording = false">
      {{ recording ? t("hotkey.press") : model ? display(model) : t("hotkey.none") }}
    </button>
    <!-- Clears it (also Backspace/Delete while recording); only with a hotkey set -->
    <button v-if="model && !recording" type="button" class="clear" :title="t('hotkey.clear')" :aria-label="t('hotkey.clear')" @click="model = ''">
      <Icon name="close" :size="12" />
    </button>
  </span>
</template>

<style scoped>
/* The field with the clear button inside at its right */
.hotkey-input {
  position: relative;
  display: inline-flex;
}

.hotkey {
  width: 100%;
  padding-right: 28px;
  text-align: left;
  font-family: inherit;
  font-size: 12px;
  cursor: pointer;
}

.clear {
  position: absolute;
  top: 50%;
  right: 6px;
  display: flex;
  padding: 2px;
  border: none;
  background: transparent;
  color: var(--text-3);
  cursor: pointer;
  transform: translateY(-50%);
}

.clear:hover {
  color: var(--text);
}

/* No hotkey: "None" dimmed like a placeholder */
.hotkey.empty {
  color: var(--text-3);
}

.hotkey.recording {
  border-color: var(--accent);
  color: var(--text-2);
}
</style>
