<script setup lang="ts">
// The refinery sync's proposals (refinerySync.ts; its scan session is not offered yet: the Scan
// button in the head is disabled until the read is checked with the current OCR model): one card
// each with station and state, the time left as the terminal shows it next to the end, and the materials. A new running job: Register (the time left as its
// duration, so the end stays the game's) or Discard; "Register all" in the head after a confirmation.
// A finished job: Store (the terminal's yields). A job no read of the station showed: Remove (after a
// confirmation) or Keep. Matched running jobs are updated without asking.
import { computed, onMounted, onUnmounted, ref } from "vue";
import Icon from "../../../adminapp/src/components/Icon.vue";
import Tooltip from "../../../adminapp/src/components/Tooltip.vue";
import ConfirmDialog, { type ConfirmButton } from "../../../webapp/src/components/ConfirmDialog.vue";
import { langRef, t } from "../i18n";
import { cscuToScu, type Proposal } from "../refinery";
import { accept, dismiss, materialName, proposals, stationName } from "../refinerySync";
import { connected } from "../state";
import { toast } from "../toasts";

const busy = ref(new Set<string>());
const setBusy = (id: string, on: boolean) => {
  const next = new Set(busy.value);
  if (on) next.add(id);
  else next.delete(id);
  busy.value = next;
};

const time = (ms: number) => new Date(ms).toLocaleTimeString(langRef.value, { hour: "2-digit", minute: "2-digit" });

// The time left counts down like on the terminal
const now = ref(Date.now());
let tick: ReturnType<typeof setInterval> | undefined;
onMounted(() => (tick = setInterval(() => (now.value = Date.now()), 1000)));
onUnmounted(() => clearInterval(tick));

/** "2h 54m", "13m 55s": the terminal's format. */
function left(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  const [h, m, sec] = [Math.floor(s / 3600), Math.floor(s / 60) % 60, s % 60];
  return h ? `${h}h ${m}m` : `${m}m ${sec}s`;
}

/** The end of a running job (new: the terminal's; missing: the registered one), else null. */
function endOf(p: Proposal): number | null {
  if (p.kind === "new") return p.endsAtMs;
  if (p.kind === "missing" && p.job.endsAt) return Date.parse(p.job.endsAt);
  return null;
}

/** The card's rows: the terminal's (new, store) or the job's (missing), as material · quality · SCU. */
function rows(p: Proposal) {
  if (p.kind === "missing") return p.job.batches.map((b) => ({ uuid: b.resourceUuid, quality: b.quality, scu: b.quantity }));
  return p.rows.map((r) => ({ uuid: r.resourceUuid, quality: r.quality, scu: cscuToScu(r.yieldCscu) }));
}

const KIND = {
  new: { tag: "refinery.kind.new", cls: "ok", action: "refinery.register", icon: "check", done: "refinery.registered" },
  store: { tag: "refinery.kind.store", cls: "ok", action: "refinery.store", icon: "check", done: "refinery.stored" },
  missing: { tag: "refinery.kind.missing", cls: "warn", action: "refinery.remove", icon: "trash", done: "refinery.removed" },
} as const;

async function run(p: Proposal) {
  if (busy.value.has(p.id)) return;
  setBusy(p.id, true);
  try {
    if (await accept(p)) toast(t(KIND[p.kind].done, { what: stationName(p.locationUuid) }));
  } finally {
    setBusy(p.id, false);
  }
}

// Removing asks first
const removing = ref<Proposal | null>(null);
const removeButtons = computed<ConfirmButton[]>(() => [
  { label: t("common.cancel"), kind: "outline", value: "cancel" },
  { label: t("refinery.remove"), kind: "danger", value: "remove", icon: "trash" },
]);
function onRemove(value: string) {
  const p = removing.value;
  removing.value = null;
  if (value === "remove" && p) void run(p);
}

function primary(p: Proposal) {
  if (p.kind === "missing") removing.value = p;
  else void run(p);
}

// "Register all": every new job, after a confirmation
const newOnes = computed(() => proposals.value.filter((p) => p.kind === "new" && !busy.value.has(p.id)));
const confirming = ref(false);
const busyAll = ref(false);
const confirmButtons = computed<ConfirmButton[]>(() => [
  { label: t("common.cancel"), kind: "outline", value: "cancel" },
  { label: t("refinery.register"), kind: "primary", value: "add", icon: "check", disabled: busyAll.value },
]);
// Why registering is locked (on the disabled button)
const lockTip = computed(() => (connected.value ? null : t("conn.off")));

async function registerAll(value: string) {
  if (value !== "add") return void (confirming.value = false);
  busyAll.value = true;
  let done = 0;
  try {
    for (const p of newOnes.value) {
      if (!(await accept(p))) break;
      done++;
    }
  } finally {
    if (done) toast(t("refinery.added", { n: done }));
    busyAll.value = false;
    confirming.value = false;
  }
}
</script>

<template>
  <section class="panel refinery">
    <div class="head">
      <Icon name="drop" :size="16" />
      <span class="head-title">{{ t("refinery.title") }}</span>
      <Tooltip :text="t('refinery.scanSoon')">
        <button type="button" class="btn small outline" disabled>
          <Icon name="eye" :size="14" /> {{ t("scan.start") }}
        </button>
      </Tooltip>
      <Tooltip :text="lockTip">
        <button type="button" class="btn small primary" :disabled="!connected || !newOnes.length || busyAll" @click="confirming = true">
          <Icon name="check" :size="14" /> {{ t("refinery.addAll") }}
        </button>
      </Tooltip>
    </div>
    <div v-if="!proposals.length" class="empty-line">{{ t("refinery.empty") }}</div>
    <div v-for="p in proposals" :key="p.id" class="job">
      <div class="job-head">
        <span class="tag" :class="KIND[p.kind].cls">{{ t(KIND[p.kind].tag) }}</span>
        <span class="job-title">{{ stationName(p.locationUuid) }}</span>
        <button
          type="button"
          class="btn small"
          :class="p.kind === 'missing' ? 'outline' : 'primary'"
          :disabled="!connected || busy.has(p.id)"
          @click="primary(p)"
        >
          <Icon :name="KIND[p.kind].icon" :size="14" /> {{ t(KIND[p.kind].action) }}
        </button>
        <Tooltip :text="t(p.kind === 'missing' ? 'refinery.keep' : 'refinery.drop')">
          <button type="button" class="icon-btn" @click="dismiss(p)"><Icon name="close" :size="14" /></button>
        </Tooltip>
      </div>
      <div v-if="endOf(p) !== null" class="job-time">
        <Icon name="clock" :size="12" />
        <span v-if="endOf(p)! > now" class="num">{{ left(endOf(p)! - now) }}</span>
        <span>{{ t("refinery.readyAt", { time: time(endOf(p)!) }) }}</span>
      </div>
      <div v-for="(x, i) in rows(p)" :key="i" class="row">
        <span class="row-name">{{ materialName(x.uuid) }}</span>
        <span class="num">{{ x.quality }}</span>
        <span class="num">{{ x.scu }} SCU</span>
      </div>
    </div>
    <ConfirmDialog
      v-if="confirming"
      :title="t('refinery.confirmAdd', { n: newOnes.length })"
      icon="plus"
      :buttons="confirmButtons"
      @choose="registerAll"
    />
    <ConfirmDialog
      v-if="removing"
      :title="t('refinery.confirmRemove', { station: stationName(removing.locationUuid) })"
      icon="trash"
      :buttons="removeButtons"
      @choose="onRemove"
    />
  </section>
</template>

<style scoped>
.refinery {
  flex-shrink: 0;
  margin-bottom: 12px;
}

.job {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 8px 16px;
  border-top: 1px solid var(--border-dim);
}

.job-head {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 28px;
}

.job-title {
  flex: 1;
  min-width: 0;
  font-weight: 600;
  font-size: 13px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* The time left and the end, below the head */
.job-time {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  color: var(--text-2);
}

.row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 40px 80px;
  gap: 8px;
  font-size: 12px;
  line-height: 1.35;
  color: var(--text-2);
}

.row-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.num {
  text-align: right;
  font-variant-numeric: tabular-nums;
}
</style>
