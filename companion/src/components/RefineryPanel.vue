<script setup lang="ts">
// Refinery jobs the OCR recognized (refineryDrafts.ts; the detection is switched in the state row):
// one card per work order with station, method, end and its ores; Register books it in the web app (POST /api/refinery/start, the duration being
// what is left of the job, so the end stays the game's), Discard drops it; "Register all" in the head
// books every complete draft after a confirmation. Nothing is booked by itself.
import { computed, ref, watch } from "vue";
import type { OkResponse } from "../../../src/webapp/api-types";
import Icon from "../../../adminapp/src/components/Icon.vue";
import Tooltip from "../../../adminapp/src/components/Tooltip.vue";
import ConfirmDialog, { type ConfirmButton } from "../../../webapp/src/components/ConfirmDialog.vue";
import { lang, t } from "../i18n";
import { resolveDraft, startRequest, type Draft } from "../refinery";
import { drafts, dropDraft, loadRefineryCatalog, refineryCatalog } from "../refineryDrafts";
import { api, connected } from "../state";
import { toast, toastError } from "../toasts";

const busy = ref(new Set<string>());

const cards = computed(() => drafts.value.map((d) => ({ d, r: refineryCatalog.value ? resolveDraft(d, refineryCatalog.value) : null })));

// The catalog follows the connection (a newer server catalog after a reconnect)
watch(connected, (c) => {
  if (c) void loadRefineryCatalog();
}, { immediate: true });

const time = (ms: number) => new Date(ms).toLocaleTimeString(lang, { hour: "2-digit", minute: "2-digit" });

function problems(card: (typeof cards.value)[number]): string[] {
  if (!card.r) return [];
  const out: string[] = [];
  if (!card.r.locationUuid) out.push(t("refinery.unknownStation", { name: card.d.station ?? "?" }));
  for (const x of card.r.rows) if (!x.oreUuid) out.push(t("refinery.unknownOre", { name: x.name }));
  return out;
}

/** The start request of a draft, null while something is not recognized. */
function request(d: Draft) {
  const r = refineryCatalog.value && resolveDraft(d, refineryCatalog.value);
  return r && startRequest(r, d.endsAtMs, Date.now());
}

async function register(d: Draft) {
  const body = request(d);
  if (!body || busy.value.has(d.id)) return;
  busy.value = new Set(busy.value).add(d.id);
  try {
    await api<OkResponse>("POST", "/refinery/start", body);
    toast(t("refinery.registered", { what: `${d.station ?? ""} · ${d.method ?? ""} · ${t("refinery.readyAt", { time: time(d.endsAtMs) })}` }));
    dropDraft(d.id);
  } catch (e) {
    toastError(e);
  } finally {
    const next = new Set(busy.value);
    next.delete(d.id);
    busy.value = next;
  }
}

// "Register all": every draft that can be registered, after a confirmation
const ready = computed(() => drafts.value.filter((d) => request(d) && !busy.value.has(d.id)));
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
    for (const d of ready.value) {
      const body = request(d);
      if (!body) continue;
      await api<OkResponse>("POST", "/refinery/start", body);
      dropDraft(d.id);
      done++;
    }
  } catch (e) {
    toastError(e);
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
      <Tooltip :text="lockTip">
        <button type="button" class="btn small primary" :disabled="!connected || !ready.length || busyAll" @click="confirming = true">
          <Icon name="check" :size="14" /> {{ t("refinery.addAll") }}
        </button>
      </Tooltip>
    </div>
    <div v-if="!cards.length" class="empty-line">{{ t("refinery.empty") }}</div>
    <div v-for="card in cards" :key="card.d.id" class="job">
      <div class="job-head">
        <span class="job-title">{{ card.d.station ?? "?" }} · {{ card.d.method ?? "?" }} · {{ t("refinery.readyAt", { time: time(card.d.endsAtMs) }) }}</span>
        <button
          type="button"
          class="btn small primary"
          :disabled="!connected || !card.r || problems(card).length > 0 || busy.has(card.d.id)"
          @click="register(card.d)"
        >
          <Icon name="check" :size="14" /> {{ t("refinery.register") }}
        </button>
        <Tooltip :text="t('refinery.drop')">
          <button type="button" class="icon-btn" @click="dropDraft(card.d.id)"><Icon name="close" :size="14" /></button>
        </Tooltip>
      </div>
      <div v-for="(x, i) in card.d.rows" :key="i" class="ore">
        <span class="ore-name">{{ x.name }}</span>
        <span class="num">{{ x.quality }}</span>
        <span class="num">{{ x.qtyCscu }} cSCU → {{ x.yieldCscu }} cSCU</span>
      </div>
      <div v-for="p in problems(card)" :key="p" class="problem">
        <Icon name="warning" :size="12" /> {{ p }}
      </div>
    </div>
    <ConfirmDialog
      v-if="confirming"
      :title="t('refinery.confirmAdd', { n: ready.length })"
      icon="plus"
      :buttons="confirmButtons"
      @choose="registerAll"
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
  gap: 4px;
  padding: 10px 16px;
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

.ore {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 60px 170px;
  gap: 8px;
  font-size: 12px;
  color: var(--text-2);
}

.ore-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.num {
  text-align: right;
  font-variant-numeric: tabular-nums;
}

.problem {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--err);
}
</style>
