<script setup lang="ts">
// The App Update dialog, after BindSight's (its VersionDialog.vue): the channel in the head, the current and the available
// version one row each, the notes in a box of fixed height under a quiet centred title, one status line that shares its row
// with the progress bar while downloading, and the buttons in the footer: Close on the left, then Check Update or Install by
// state (shellLogic.ts). Closes by its button or Escape only. Its classes carry a prefix (upd-): the global table styles
// (ui.css `.row` and others) must not reach in here.
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
    <div class="upd-rows">
      <div class="upd-row">
        <span class="upd-label">{{ t("update.current") }}:</span>
        <span class="upd-version mono">{{ u?.current ? `v${u.current}` : "–" }}</span>
      </div>
      <div class="upd-row">
        <span class="upd-label">{{ t("update.available") }}:</span>
        <span class="upd-version mono" :class="u?.available ? 'found' : 'none'">{{ u?.available ? `v${u.available}` : "–" }}</span>
      </div>
    </div>
    <!-- The box keeps its height without notes: nothing jumps -->
    <div class="upd-notes-block">
      <div class="upd-notes-title">{{ t("update.notes") }}:</div>
      <div class="upd-notes" :class="{ empty: !u?.notes }" tabindex="0">{{ u?.notes ?? "" }}</div>
    </div>
    <!-- The status line keeps its height while empty; the download shares it with the progress bar -->
    <div class="upd-status" :class="{ busy: !!status?.text && !status?.error, err: !!status?.error }">
      <template v-if="status">
        <span v-if="status.error" class="upd-status-text" :title="status.error">{{ status.error }}</span>
        <span v-else-if="status.text" class="upd-status-text">{{ t(status.text) }}<template v-if="status.percent !== null"> {{ status.percent }} %</template></span>
        <div v-if="u?.state === 'downloading'" class="upd-progress">
          <div class="upd-bar" :class="{ unknown: status.percent === null }" :style="{ width: `${status.percent ?? 0}%` }" />
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

.upd-rows {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.upd-row {
  display: flex;
  align-items: center;
  gap: 14px;
}

/* Room for the longer label of both languages */
.upd-label {
  width: 150px;
  flex-shrink: 0;
  font-size: 14px;
  color: var(--text-2);
}

.upd-version {
  font-size: 15px;
  color: var(--text);
}

.upd-version.none {
  color: var(--text-2);
}

.upd-version.found {
  color: var(--accent);
  font-weight: 600;
}

.upd-notes-block {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.upd-notes-title {
  text-align: center;
  font-size: 12px;
  color: var(--text-3);
}

.upd-notes {
  height: 120px;
  box-sizing: border-box;
  overflow-y: auto;
  padding: 10px 12px;
  border: 1px solid var(--border-dim);
  border-radius: var(--radius-control);
  background: var(--bg-surface-2);
  font-size: 13px;
  line-height: 1.45;
  color: var(--text-2);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

/* No notes: the box stays, its content does not */
.upd-notes.empty {
  visibility: hidden;
}

.upd-status {
  min-height: 18px;
  display: flex;
  align-items: center;
  gap: 12px;
  font-size: 13px;
  color: var(--text-3);
}

.upd-status-text {
  flex-shrink: 0;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
}

.upd-status.busy {
  color: var(--warn);
}

.upd-status.err {
  color: var(--err);
}

.upd-progress {
  flex: 1;
  height: 6px;
  border-radius: 3px;
  background: var(--border-dim);
  overflow: hidden;
}

.upd-bar {
  height: 100%;
  background: var(--accent);
}

/* The size is not known: a slice that runs to and fro */
.upd-bar.unknown {
  width: 30% !important;
  animation: upd-slide 1s ease-in-out infinite alternate;
}

@keyframes upd-slide {
  from {
    margin-left: 0;
  }
  to {
    margin-left: 70%;
  }
}
</style>
