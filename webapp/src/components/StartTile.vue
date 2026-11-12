<script setup lang="ts">
// The start tile: shown instead of the app while the singleuser variant has no game data. The logo, the wordmark, the app version, a
// row of segments and one line of text; without a connection the tag and the two ways out (import a file, try again).
import { computed, ref } from "vue";
import Icon from "../../../adminapp/src/components/Icon.vue";
import logo from "../../../adminapp/src/assets/logo-128.png";
import logo2x from "../assets/logo-256.png";
import { lang, t } from "../i18n";
import { checkData } from "../local";
import { megabytes } from "../localTime";
import { shell } from "../shell";
import { progressShare, type TileModel } from "../startTile";
import { toastError } from "../toasts";
import ImportDialog from "./ImportDialog.vue";

const props = defineProps<{ model: Extract<TileModel, { visible: true }>; version: string | null }>();

const importing = ref(false);
const retrying = ref(false);

const steps = computed(() => (props.model.view === "steps" ? props.model : null));
const amount = computed(() => (steps.value?.progress ? megabytes(steps.value.progress.done, steps.value.progress.total, lang.value) : ""));
const share = computed(() => progressShare(steps.value?.progress ?? null));
// The ways out: with nothing to wait for
const actions = computed(() => ["offline", "missing", "tooOld"].includes(props.model.view));

async function retry() {
  retrying.value = true;
  try {
    await checkData();
  } catch (e) {
    toastError(e);
  } finally {
    retrying.value = false;
  }
}
</script>

<template>
  <div class="start">
    <div class="panel tile">
      <div class="top">
        <img class="icon-slot" :src="logo" :srcset="`${logo} 1x, ${logo2x} 2x`" alt="" draggable="false" />
        <div class="wordmark">QUARTER<span class="accent">MASTER</span></div>
        <div class="version mono">{{ version ? `v${version}` : "" }}&nbsp;</div>
      </div>
      <div class="low">
        <template v-if="steps">
          <div class="segments" role="progressbar" :aria-valuemin="0" :aria-valuemax="steps.segments" :aria-valuenow="steps.step">
            <span v-for="n in steps.segments" :key="n" class="seg" :class="{ on: n <= steps.step }" />
          </div>
          <div class="line">
            <span>{{ t(steps.text) }}</span>
            <span class="amount mono">{{ amount }}</span>
          </div>
          <div class="bar" :class="{ hidden: !steps.progress }"><div class="fill" :style="{ width: `${share * 100}%` }" /></div>
        </template>
        <template v-else>
          <div class="state">
            <span v-if="model.view === 'offline'" class="tag warn"><Icon name="wifi-off" :size="12" /> {{ t("start.noConnection") }}</span>
            <span v-else-if="model.view === 'tooOld'" class="tag warn"><Icon name="warning" :size="12" /> {{ t("update.title") }}</span>
            <span v-else-if="model.view === 'unreachable'" class="tag err"><Icon name="wifi-off" :size="12" /> {{ t("start.noConnection") }}</span>
            <span class="sentence">{{
              model.view === "tooOld" ? t("update.text") : model.view === "unreachable" ? t("error.backend") : t("start.missing")
            }}</span>
          </div>
          <div class="actions" :class="{ hidden: !actions }">
            <button class="btn outline" type="button" :disabled="!actions || retrying" @click="retry">
              <Icon name="refresh" :size="14" /> {{ t("start.retry") }}
            </button>
            <button class="btn primary" type="button" :disabled="!actions" @click="importing = true">
              <Icon name="imports" :size="14" /> {{ t("data.import") }}
            </button>
            <button v-if="model.view === 'tooOld' && shell.updateAvailable" class="btn outline" type="button" @click="shell.openUpdate()">
              <Icon name="imports" :size="14" /> {{ t("update.button") }}
            </button>
          </div>
        </template>
      </div>
    </div>
    <ImportDialog v-if="importing" @close="importing = false" />
  </div>
</template>

<style scoped>
/* Fills what the title bar of the desktop window leaves (the app is a column as high as the window) */
.start {
  flex: 1;
  box-sizing: border-box;
  display: flex;
  align-items: stretch;
  padding: 16px;
}

.tile {
  flex: 1;
  align-items: center;
  justify-content: center;
  gap: 48px;
}

.top {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 14px;
}

/* The app's logo (the splash of the desktop shell shows the same picture at the same place) */
.icon-slot {
  width: 128px;
  height: 128px;
  display: block;
}

.wordmark {
  font-size: 40px;
  font-weight: 700;
  letter-spacing: 0.22em;
  /* The last letter's spacing would push the word off centre */
  margin-right: -0.22em;
  color: var(--text);
  white-space: nowrap;
}

.wordmark .accent {
  color: var(--accent);
}

.version {
  font-size: 13px;
  color: var(--text-2);
}

/* One block for every state: the tile does not change its size when the state does */
.low {
  width: min(420px, calc(100% - 32px));
  height: 84px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.segments {
  display: flex;
  gap: 6px;
}

.seg {
  flex: 1;
  height: 6px;
  border-radius: var(--radius-control);
  background: var(--bg-surface-3);
}

.seg.on {
  background: var(--accent);
}

/* Everything on the tile is centred: the text and the amount after it, the tag and the sentence, the buttons */
.line {
  height: 20px;
  display: flex;
  justify-content: center;
  align-items: baseline;
  font-size: 13px;
  color: var(--text-2);
}

/* The gap only while there is an amount: the text stays in the middle without one */
.amount:not(:empty) {
  margin-left: 10px;
}

.amount {
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}

.bar {
  height: 4px;
  border-radius: var(--radius-control);
  background: var(--bg-surface-2);
  overflow: hidden;
}

.bar.hidden,
.actions.hidden {
  visibility: hidden;
}

.fill {
  height: 4px;
  background: var(--warn);
}

.state {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
  min-height: 20px;
}

.tag {
  gap: 6px;
}

.sentence {
  font-size: 13px;
  color: var(--text);
  text-align: center;
}

.actions {
  display: flex;
  justify-content: center;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 6px;
}
</style>
