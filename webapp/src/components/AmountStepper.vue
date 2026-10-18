<script setup lang="ts">
// An amount (SCU or pieces) between minus and plus, only as wide as it needs: the buttons step by one
// SCU or piece (a typed fraction keeps its part) and stop at `min`; typing stays free, the parent
// checks the text (`invalid`).
import { computed } from "vue";
import Icon from "../../../adminapp/src/components/Icon.vue";
import { type Unit, unitText } from "../format";
import { t } from "../i18n";

const props = withDefaults(defineProps<{ unit: Unit; invalid?: boolean; disabled?: boolean; min?: number; label?: string }>(), {
  invalid: false, disabled: false, min: 1, label: undefined,
});
const model = defineModel<string>({ required: true });

// What the buttons count from: the typed number, or nothing yet
const current = computed(() => {
  const n = Number(model.value.trim().replace(",", "."));
  return model.value.trim() !== "" && Number.isFinite(n) ? n : null;
});
const step = (by: number) => {
  const n = current.value ?? (by > 0 ? props.min - 1 : props.min);
  model.value = String(Math.round(Math.max(props.min, n + by) * 1e6) / 1e6);
};
</script>

<template>
  <span class="stepper">
    <button type="button" class="icon-btn" :title="t('stock.less')" :disabled="disabled || current === null || current <= min" @click="step(-1)">
      <Icon name="minus" :size="14" />
    </button>
    <input v-model="model" class="input count-input" :class="{ invalid }" type="text" :inputmode="unit === 'SCU' ? 'decimal' : 'numeric'"
      :disabled="disabled" :aria-label="label" />
    <button type="button" class="icon-btn" :title="t('stock.more')" :disabled="disabled" @click="step(1)"><Icon name="plus" :size="14" /></button>
    <span class="unit">{{ unitText(unit) }}</span>
  </span>
</template>

<style scoped>
.stepper {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  align-self: flex-start;
}

.stepper .icon-btn {
  margin: 0;
}

.count-input {
  width: 10ch;
  text-align: center;
}

.unit {
  font-size: 13px;
  color: var(--text-2);
  white-space: nowrap;
}
</style>
