<script setup lang="ts">
// Sets the time a running refinery job still needs (POST /api/refinery/duration), e.g. read off the
// terminal later: the end becomes now + that time. All fields empty clears the end ("duration open").
import { computed, ref } from "vue";
import type { OkResponse, RefineryDurationRequest } from "../../../src/webapp/api-types";
import { api } from "../api";
import { durationOfParts, hm, partsOf } from "../format";
import { t } from "../i18n";
import { toast, toastError } from "../toasts";
import ConfirmDialog, { type ConfirmButton } from "./ConfirmDialog.vue";

const props = defineProps<{ jobId: string; location: string; endsAt: string | null }>();
const emit = defineEmits<{ close: [] }>();

// Prefilled with the time left, if the job has an end still ahead
const leftNow = props.endsAt ? Math.ceil((Date.parse(props.endsAt) - Date.now()) / 1000) : 0;
const start = leftNow > 0 ? partsOf(leftNow) : { h: "", m: "", s: "" };
const hours = ref(start.h);
const minutes = ref(start.m);
const seconds = ref(start.s);
const busy = ref(false);

const durationSeconds = computed(() => durationOfParts(hours.value, minutes.value, seconds.value));
// Empty clears the end: pointless while there is none
const valid = computed(() => durationSeconds.value !== null && (durationSeconds.value !== undefined || props.endsAt !== null));
const buttons = computed<ConfirmButton[]>(() => [
  { label: t("common.cancel"), kind: "outline", value: "cancel" },
  { label: t("common.save"), kind: "primary", value: "save", icon: "check", form: "refinery-time", disabled: !valid.value || busy.value },
]);

async function save() {
  if (!valid.value || busy.value) return;
  busy.value = true;
  try {
    const value = durationSeconds.value ?? null;
    const body: RefineryDurationRequest = { jobId: props.jobId, durationSeconds: value };
    await api<OkResponse>("/refinery/duration", { method: "POST", body });
    toast(value === null
      ? t("refinery.timeCleared", { what: props.location })
      : t("refinery.timeSet", { what: `${props.location} · ${hm(value)}` }));
    emit("close");
  } catch (e) {
    toastError(e);
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <ConfirmDialog :title="t('refinery.setTime')" :subtitle="location" icon="clock" :buttons="buttons" @choose="emit('close')">
    <form id="refinery-time" class="form single flush" @submit.prevent="save">
      <div class="field">
        {{ t("refinery.timeLeft") }}
        <span class="with-unit">
          <input v-model="hours" class="input short" :class="{ invalid: durationSeconds === null }" type="text" inputmode="numeric" />
          <span class="unit">{{ t("time.h") }}</span>
          <input v-model="minutes" class="input short" :class="{ invalid: durationSeconds === null }" type="text" inputmode="numeric" />
          <span class="unit">{{ t("time.m") }}</span>
          <input v-model="seconds" class="input short" :class="{ invalid: durationSeconds === null }" type="text" inputmode="numeric" />
          <span class="unit">{{ t("time.s") }}</span>
        </span>
      </div>
    </form>
  </ConfirmDialog>
</template>
