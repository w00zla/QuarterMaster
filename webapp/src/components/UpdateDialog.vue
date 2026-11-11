<script setup lang="ts">
// The App Update dialog (BindSight's, in this app's design): the channel in the head, the current and the available version
// as chips, the notes in a box of fixed height, one status line (a progress bar while downloading) and the buttons in the
// footer: Close on the left, then Check Update or Install by state (shellLogic.ts). Closes by its button or Escape only.
import { computed } from "vue";
import { t } from "../i18n";
import { shell } from "../shell";
import { statusLine, updateBusy, updateButtons, type UpdateAction } from "../shellLogic";
import ConfirmDialog, { type ConfirmButton } from "./ConfirmDialog.vue";
import Dropdown from "./Dropdown.vue";

const u = computed(() => shell.update);

const LABELS = { close: "common.close", check: "update.check", install: "update.install" } as const;
// The check and install buttons take the same place: each reserves the other's text
const buttons = computed<ConfirmButton[]>(() =>
  updateButtons(u.value?.state ?? "idle").map((b) => ({
    label: t(LABELS[b.action]),
    kind: b.kind,
    value: b.action,
    disabled: b.disabled,
    side: b.left ? "left" : undefined,
    reserve: b.action === "close" ? undefined : [t(b.action === "check" ? LABELS.install : LABELS.check)],
  })),
);

const channels = computed(() => (u.value?.channels ?? []).map((id) => ({ value: id, label: id === "stable" ? "Stable" : id })));
const busy = computed(() => !u.value || updateBusy(u.value.state));
const status = computed(() => (u.value ? statusLine(u.value) : null));

function pickChannel(id: string) {
  if (!u.value || busy.value || id === u.value.channel) return;
  void shell.setChannel(id);
}

function choose(action: string) {
  const what = action as UpdateAction;
  if (what === "close") shell.closeUpdate();
  else if (what === "check") void shell.checkUpdate();
  else if (what === "install") void shell.installUpdate();
}
</script>

<template>
  <ConfirmDialog :title="t('update.button')" icon="imports" :buttons="buttons" @choose="choose">
    <template #head>
      <span class="channel-label">{{ t("update.channel") }}</span>
      <Dropdown :model-value="u?.channel ?? ''" :options="channels" placeholder="–" variant="small" :disabled="busy" :title="t('update.channel')" @update:model-value="pickChannel" />
    </template>
    <div class="rows">
      <div class="row">
        <span class="k">{{ t("update.current") }}</span>
        <span class="ver-chip">{{ u?.current ? `v${u.current}` : "–" }}</span>
      </div>
      <div class="row">
        <span class="k">{{ t("update.available") }}</span>
        <span class="ver-chip" :class="u?.available ? 'found' : 'none'">{{ u?.available ? `v${u.available}` : "–" }}</span>
      </div>
    </div>
    <!-- The box keeps its height without notes: nothing jumps -->
    <div class="notes-block">
      <span class="k">{{ t("update.notes") }}</span>
      <div class="notes" :class="{ empty: !u?.notes }" tabindex="0">{{ u?.notes ?? "" }}</div>
    </div>
    <!-- The status line keeps its height while empty -->
    <div class="status">
      <template v-if="status">
        <div class="line">
          <span v-if="status.error" class="err-text" :title="status.error">{{ status.error }}</span>
          <span v-else-if="status.text" class="busy-text">{{ t(status.text) }}</span>
          <span v-if="status.percent !== null" class="pct mono">{{ status.percent }} %</span>
        </div>
        <div v-if="u?.state === 'downloading'" class="bar">
          <div class="fill" :class="{ unknown: status.percent === null }" :style="{ width: `${status.percent ?? 0}%` }" />
        </div>
      </template>
    </div>
  </ConfirmDialog>
</template>

<style scoped>
.channel-label {
  font-size: 12px;
  color: var(--text-2);
}

.rows {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.row {
  display: flex;
  align-items: center;
  gap: 12px;
}

.k {
  font-size: 12px;
  color: var(--text-2);
}

.row .k {
  width: 150px;
  flex-shrink: 0;
}

.ver-chip.found {
  color: var(--accent);
}

.notes-block {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.notes {
  height: 120px;
  box-sizing: border-box;
  overflow-y: auto;
  padding: 10px;
  border-radius: var(--radius-control);
  background: var(--bg-base);
  color: var(--text-2);
  font-size: 13px;
  line-height: 1.5;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

/* No notes: the box stays, its content does not */
.notes.empty {
  visibility: hidden;
}

.status {
  height: 30px;
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: 6px;
}

.line {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  gap: 12px;
  min-width: 0;
}

.busy-text {
  color: var(--warn);
}

.err-text {
  color: var(--err);
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.pct {
  font-size: 12px;
  color: var(--text-2);
}

.bar {
  height: 4px;
  border-radius: 4px;
  background: var(--border-dim);
  overflow: hidden;
}

.fill {
  height: 4px;
  background: var(--warn);
}

/* The size is not known: a slice that runs to and fro */
.fill.unknown {
  width: 30% !important;
  animation: slide 1s ease-in-out infinite alternate;
}

@keyframes slide {
  from {
    margin-left: 0;
  }
  to {
    margin-left: 70%;
  }
}
</style>
