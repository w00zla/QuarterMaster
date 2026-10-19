<script setup lang="ts">
// The refinery sync's proposals (refinerySync.ts; the scan is in the scan row, ScanBar.vue), below the
// head the filter "Jobs" (off: the scan does not read the terminal): one card each in three lines: the
// job badge (icon-only), the station and the actions; the state (a colour per state) with the time left
// as the terminal shows it and the end; the materials as compact rows like the inventory's table. A new running job: Register (the time left as its
// duration, so the end stays the game's) or Discard; "Register all" in the head after a confirmation.
// A finished job, registered or not: Store (the terminal's yields). A job no read of the station showed: Remove (after a
// confirmation) or Keep. Matched running jobs are updated without asking.
import { computed, onMounted, onUnmounted, ref, watchEffect } from "vue";
import Icon from "../../../adminapp/src/components/Icon.vue";
import Tooltip from "../../../adminapp/src/components/Tooltip.vue";
import ConfirmDialog, { type ConfirmButton } from "../../../webapp/src/components/ConfirmDialog.vue";
import { langRef, t } from "../i18n";
import { overlayRows, tabCounts } from "../overlay";
import { fromMicro, toMicro } from "../inventory";
import { cscuToScu, type Proposal } from "../refinery";
import { accept, dismiss, jobsOn, materialName, proposals, stationName, toggleJobs } from "../refinerySync";
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

/** The card's total yield in SCU (exact, like the stock). */
const total = (p: Proposal) => fromMicro(rows(p).reduce((sum, x) => sum + toMicro(x.scu), 0n));
// A registered job behind the card (store, missing), or not yet (new, finished)
const registered = (p: Proposal) => p.kind === "store" || p.kind === "missing";

// Per proposal: its state tag (a colour each: new blue, finished green, missing yellow), the action's
// label, icon and button look (storing: a crate on green, apart from registering)
const KIND = {
  new: { tag: "refinery.kind.new", cls: "accent", action: "refinery.register", icon: "check", button: "primary", done: "refinery.registered" },
  store: { tag: "refinery.kind.store", cls: "ok", action: "refinery.store", icon: "type-crate", button: "store", done: "refinery.stored" },
  // A completed order without a registered job: its materials into the stock
  finished: { tag: "refinery.kind.store", cls: "ok", action: "refinery.store", icon: "type-crate", button: "store", done: "refinery.stored" },
  missing: { tag: "refinery.kind.missing", cls: "warn", action: "refinery.remove", icon: "trash", button: "outline", done: "refinery.removed" },
} as const;

// The scan overlay shows one line per card: station, materials, the end
watchEffect(() => {
  overlayRows.refinery = proposals.value.map((p) => {
    const end = endOf(p);
    return {
      tag: t(KIND[p.kind].tag),
      cls: KIND[p.kind].cls,
      name: stationName(p.locationUuid),
      detail: rows(p).map((x) => materialName(x.uuid)).join(", "),
      cols: end === null ? [] : [t("refinery.readyAt", { time: time(end) })],
    };
  });
  tabCounts.refinery = proposals.value.length;
});

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
      <span class="head-title">{{ t("refinery.title") }} <span class="head-count">{{ proposals.length }}</span></span>
      <Tooltip :text="lockTip">
        <button type="button" class="btn small primary" :disabled="!connected || !newOnes.length || busyAll" @click="confirming = true">
          <Icon name="check" :size="14" /> {{ t("refinery.addAll") }}
        </button>
      </Tooltip>
    </div>
    <!-- What the scan detects: off, the terminal is not read -->
    <div class="chips filter">
      <span class="filter-label">{{ t("inventory.scanned") }}</span>
      <button type="button" class="chip" :class="{ active: jobsOn }" :aria-pressed="jobsOn" @click="toggleJobs">
        <Icon name="drop" :size="12" /> {{ t("refinery.jobs") }}
        <Icon :name="jobsOn ? 'check' : 'close'" :size="12" />
      </button>
    </div>
    <div v-if="!proposals.length" class="empty-line">{{ t("refinery.empty") }}</div>
    <!-- Only the jobs scroll: the head stays -->
    <div v-else class="jobs">
      <div v-for="p in proposals" :key="p.id" class="job">
        <!-- 1: the job badge, the station, the actions -->
        <div class="job-head">
          <Tooltip :text="t('refinery.jobs')">
            <span class="tag app kind"><Icon name="drop" :size="11" /></span>
          </Tooltip>
          <span class="job-title">{{ stationName(p.locationUuid) }}</span>
          <button
            type="button"
            class="btn small"
            :class="KIND[p.kind].button"
            :disabled="!connected || busy.has(p.id)"
            @click="primary(p)"
          >
            <Icon :name="KIND[p.kind].icon" :size="14" /> {{ t(KIND[p.kind].action) }}
          </button>
          <Tooltip :text="t(p.kind === 'missing' ? 'refinery.keep' : 'refinery.drop')">
            <button type="button" class="icon-btn" @click="dismiss(p)"><Icon name="close" :size="14" /></button>
          </Tooltip>
        </div>
        <!-- 2: the state, whether a job is registered, the time left and the end; the total yield at the right -->
        <div class="job-state">
          <span class="tag" :class="KIND[p.kind].cls">{{ t(KIND[p.kind].tag) }}</span>
          <Tooltip :text="t(registered(p) ? 'refinery.isRegistered' : 'refinery.notRegistered')">
            <span class="tag kind" :class="{ accent: registered(p), off: !registered(p) }"><Icon name="link" :size="11" /></span>
          </Tooltip>
          <template v-if="endOf(p) !== null">
            <Icon name="clock" :size="12" />
            <span v-if="endOf(p)! > now" class="num">{{ left(endOf(p)! - now) }}</span>
            <span>{{ t("refinery.readyAt", { time: time(endOf(p)!) }) }}</span>
          </template>
          <span class="num total">{{ total(p) }} SCU</span>
        </div>
        <!-- 3: the materials, like the inventory's table -->
        <div class="mats">
          <div v-for="(x, i) in rows(p)" :key="i" class="row">
            <span class="row-name">{{ materialName(x.uuid) }}</span>
            <span class="num">{{ x.quality }}</span>
            <span class="num">{{ x.scu }} SCU</span>
          </div>
        </div>
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
/* Fills the main area, only its jobs scroll */
.refinery {
  flex: 1;
  min-height: 0;
}

.jobs {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
}

/* The filter below the head, like the inventory's: one chip, on = the live colour with a check, off =
   dashed and dimmed with an x */
.filter {
  align-items: center;
  gap: 6px;
  padding: 4px 16px 8px;
  font-size: 11px;
}

.filter-label {
  color: var(--text-2);
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}

.filter .chip {
  height: 22px;
  gap: 4px;
  padding: 0 8px;
  font-size: 11px;
  border-style: dashed;
  color: var(--text-3);
}

.filter .chip.active {
  border-style: solid;
  border-color: color-mix(in srgb, var(--live) 45%, transparent);
  background: color-mix(in srgb, var(--live) 14%, transparent);
  color: var(--live);
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

/* The job badge: icon-only, small, like the inventory's kind badges */
.tag.kind {
  height: 16px;
  padding: 0 2px;
}

/* Not registered as a job yet: the link badge dimmed */
.tag.kind.off {
  color: var(--text-3);
}

/* The total yield, aligned with the materials' amount column */
.total {
  margin-left: auto;
  color: var(--text);
}

/* Storing: set apart from registering (green, a crate) */
.btn.store {
  background: var(--ok);
  color: var(--accent-text);
  border: none;
}

/* The state tag, the time left and the end, below the head */
.job-state {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 22px;
  font-size: 12px;
  color: var(--text-2);
}

/* The materials: compact rows like the inventory's table (its quality and amount columns) */
.mats {
  margin-top: 4px;
}

.row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 40px 88px;
  align-items: center;
  gap: 8px;
  min-height: 22px;
  font-size: 12px;
  line-height: 1.35;
  color: var(--text-2);
  border-top: 1px solid var(--border-dim);
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
