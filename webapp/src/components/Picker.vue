<script lang="ts">
import type { InjectionKey } from "vue";

export interface PickerOption {
  value: string;
  label: string;
  // Dim second text in the suggestion (searched too)
  hint?: string;
}

/** The picker's own texts, provided by the app (the web app's from its i18n; the companion app
 * provides its own: this component has no i18n of its own so that both can import it). */
export interface PickerLabels {
  clear: string;
  noMatch: string;
}

export const PICKER_LABELS: InjectionKey<PickerLabels> = Symbol("pickerLabels");
</script>

<script setup lang="ts">
// A searchable picker (combobox): type to filter, up/down/enter/escape, every match listed (the list scrolls).
// All typed words must match; entries whose label starts with the first word come first, otherwise the
// caller's order stays. Text that was not picked is dropped on blur: only listed values get through.
import { computed, inject, nextTick, ref, watch } from "vue";
import Icon from "../../../adminapp/src/components/Icon.vue";

const labels = inject(PICKER_LABELS, { clear: "Clear", noMatch: "No match" });

const props = withDefaults(
  // strong: the picked entry in bold (the main choice of a form)
  defineProps<{ modelValue: string | null; options: PickerOption[]; placeholder?: string; disabled?: boolean; strong?: boolean }>(),
  { placeholder: "", disabled: false, strong: false },
);
const emit = defineEmits<{ "update:modelValue": [value: string | null] }>();

const text = ref("");
const open = ref(false);
const active = ref(0);
const list = ref<HTMLElement | null>(null);

const selected = computed(() => props.options.find((o) => o.value === props.modelValue) ?? null);
watch(selected, (s) => {
  if (!open.value) text.value = s?.label ?? "";
}, { immediate: true });

const matches = computed(() => {
  if (!open.value) return [];
  // The picked label in the box shows the full list, not just itself
  const query = selected.value && text.value === selected.value.label ? "" : text.value;
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return props.options;
  const first = words[0]!;
  const hits = props.options.filter((o) => {
    const hay = `${o.label} ${o.hint ?? ""}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  });
  const head = hits.filter((o) => o.label.toLowerCase().startsWith(first));
  const rest = hits.filter((o) => !o.label.toLowerCase().startsWith(first));
  return [...head, ...rest];
});

function onFocus(e: FocusEvent) {
  open.value = true;
  active.value = 0;
  (e.target as HTMLInputElement).select();
}

function onInput() {
  open.value = true;
  active.value = 0;
}

function pick(o: PickerOption) {
  open.value = false;
  text.value = o.label;
  emit("update:modelValue", o.value);
}

function close() {
  open.value = false;
  if (!text.value.trim()) {
    text.value = "";
    if (props.modelValue !== null) emit("update:modelValue", null);
  } else text.value = selected.value?.label ?? "";
}

function clear() {
  text.value = "";
  emit("update:modelValue", null);
}

function move(step: number) {
  if (!open.value) open.value = true;
  const n = matches.value.length;
  if (!n) return;
  active.value = (active.value + step + n) % n;
  void nextTick(() => list.value?.children[active.value]?.scrollIntoView({ block: "nearest" }));
}

function onKey(e: KeyboardEvent) {
  if (e.key === "ArrowDown") {
    e.preventDefault();
    move(1);
  } else if (e.key === "ArrowUp") {
    e.preventDefault();
    move(-1);
  } else if (e.key === "Enter") {
    const o = matches.value[active.value];
    if (open.value && o) {
      e.preventDefault();
      pick(o);
    }
  } else if (e.key === "Escape" && open.value) {
    // Closes the list only, not a dialog around it (ConfirmDialog skips prevented events)
    e.preventDefault();
    close();
  }
}
</script>

<template>
  <div class="picker" :class="{ disabled }">
    <input
      v-model="text"
      class="picker-input"
      :class="{ picked: strong && selected && text === selected.label }"
      type="text"
      role="combobox"
      autocomplete="off"
      spellcheck="false"
      :aria-expanded="open"
      :placeholder="placeholder"
      :disabled="disabled"
      @focus="onFocus"
      @input="onInput"
      @blur="close"
      @keydown="onKey"
    />
    <button v-if="selected && !disabled" type="button" class="clear" :title="labels.clear" tabindex="-1" @mousedown.prevent @click="clear">
      <Icon name="close" :size="12" />
    </button>
    <div v-if="open" ref="list" class="picker-menu" role="listbox">
      <button
        v-for="(o, i) in matches"
        :key="o.value"
        type="button"
        role="option"
        class="picker-item"
        :class="{ active: i === active, current: o.value === modelValue }"
        :aria-selected="i === active"
        tabindex="-1"
        @mousedown.prevent
        @click="pick(o)"
      >
        <span class="label">{{ o.label }}</span>
        <span v-if="o.hint" class="hint">{{ o.hint }}</span>
      </button>
      <div v-if="!matches.length" class="none">{{ labels.noMatch }}</div>
    </div>
  </div>
</template>

<style scoped>
.picker {
  position: relative;
  width: 100%;
  min-width: 0;
}

.picker-input {
  width: 100%;
  height: var(--h-chip);
  padding: 0 28px 0 10px;
  border: 1px solid transparent;
  border-radius: var(--radius-control);
  background: var(--field-bg);
  color: var(--text);
  font-family: inherit;
  font-size: 13px;
  outline: none;
  box-sizing: border-box;
}

.picker-input:focus {
  border-color: var(--accent);
}

.picker-input::placeholder {
  color: rgba(173, 211, 235, 0.6);
}

/* strong: the picked entry stands out (not while typing a search) */
.picker-input.picked {
  font-weight: 600;
}

.disabled .picker-input {
  opacity: 0.5;
}

.clear {
  position: absolute;
  right: 6px;
  top: 50%;
  transform: translateY(-50%);
  width: 20px;
  height: 20px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: none;
  background: transparent;
  color: var(--text-3);
  cursor: pointer;
}

.clear:hover {
  color: var(--text);
}

.picker-menu {
  position: absolute;
  top: calc(100% + 4px);
  left: 0;
  right: 0;
  max-height: 300px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  padding: 4px;
  border: 1px solid var(--border);
  border-radius: var(--radius-control);
  background: var(--bg-surface);
  z-index: 40;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.4);
}

.picker-item {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 1px;
  padding: 5px 10px;
  border: none;
  border-radius: var(--radius-control);
  background: transparent;
  font-family: inherit;
  font-size: 13px;
  color: var(--text-2);
  cursor: pointer;
  text-align: left;
}

.picker-item.active {
  background: var(--bg-surface-2);
  color: var(--text);
}

.picker-item.current .label {
  color: var(--live);
}

.label {
  overflow-wrap: anywhere;
}

.hint {
  font-size: 11px;
  color: var(--text-3);
}

.none {
  padding: 6px 10px;
  font-size: 13px;
  color: var(--text-3);
}
</style>
