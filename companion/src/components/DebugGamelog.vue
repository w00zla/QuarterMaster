<script setup lang="ts">
// The debug window's Game.log tab: the followed file (path, times, size, how far it is read), every
// blueprint unlock (current log and scanned old logs, registered and default ones included) with how the
// main window matched it to the catalog, and the location: the last key the log named, what it resolves
// to, the auto location and the pick, every location line of the current log. The log state comes from
// the Rust side (re-read on "log-changed" and every few seconds for the file's size and times), the
// matching from the main window ("gamelog-report", debugReport.ts). "Export" writes both into a JSON
// file in a folder the user picks.
import { computed, onMounted, onUnmounted, ref } from "vue";
import { emit, listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import Icon from "../../../adminapp/src/components/Icon.vue";
import { exportLogDebug, logState, type LogState } from "../backend";
import type { GamelogReport, UnlockState } from "../debugReport";
import { t } from "../i18n";
import { errorText, toast, toastError } from "../toasts";

// The file's size and times change all the time: re-read at this interval
const POLL_MS = 2000;

const log = ref<LogState | null>(null);
const report = ref<GamelogReport | null>(null);
const busy = ref(false);

const load = async () => {
  log.value = await logState();
};
let timer: ReturnType<typeof setInterval> | undefined;

onMounted(async () => {
  try {
    await load();
    await listen("log-changed", () => void load().catch(() => undefined));
    await listen<GamelogReport>("gamelog-report", (e) => (report.value = e.payload));
    await emit("gamelog-report-request");
    timer = setInterval(() => void load().catch(() => undefined), POLL_MS);
  } catch (e) {
    toast(errorText(e), "error");
  }
});
onUnmounted(() => clearInterval(timer));

const pad = (n: number) => String(n).padStart(2, "0");
// Local time as "2026-10-07 14:05:09" in every language
function when(at: string | number | null): string {
  if (at === null || at === "") return "–";
  const d = new Date(at);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
const mb = (bytes: number) => `${(bytes / 1e6).toFixed(1)} MB`;

// Every unlock, newest first, filtered by state (the catalog still loading always shows)
const STATES: { state: UnlockState; cls: string }[] = [
  { state: "new", cls: "accent" },
  { state: "pick", cls: "warn" },
  { state: "unknown", cls: "warn" },
  { state: "owned", cls: "ok" },
  { state: "default", cls: "" },
];
const STATE_CLASS: Record<UnlockState, string> = { new: "accent", pick: "warn", unknown: "warn", owned: "ok", default: "", loading: "" };
const shown = ref(new Set<UnlockState>(STATES.map((s) => s.state)));
function toggleState(state: UnlockState) {
  const next = new Set(shown.value);
  if (next.has(state)) next.delete(state);
  else next.add(state);
  shown.value = next;
}
const unlocks = computed(() => report.value?.unlocks ?? []);
const unlockRows = computed(() => unlocks.value.filter((u) => u.state === "loading" || shown.value.has(u.state)));

// The location keys resolved by the main window's catalog (null: not loaded yet)
const resolve = (key: string): string | null | undefined => (report.value?.catalog ? (report.value.locations[key.toLowerCase()] ?? null) : undefined);
const locationLines = computed(() => [...(log.value?.locations ?? [])].reverse());
const logged = computed(() => log.value?.location ?? null);

/** Writes the log state and the main window's report into a JSON file in a folder the user picks. */
async function exportLog() {
  busy.value = true;
  try {
    const dir = await open({ directory: true });
    if (typeof dir !== "string") return;
    toast(t("debug.exported", { path: await exportLogDebug(dir, report.value) }));
  } catch (e) {
    toastError(e);
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <section class="pane">
    <div class="sub">
      <span class="tag" :class="log?.found ? 'ok' : 'warn'">{{ t(log?.found ? "log.found" : "log.missing") }}</span>
      <div class="spacer" />
      <button type="button" class="btn small outline" :disabled="busy" @click="exportLog">
        <Icon name="file" :size="14" /> {{ t("debug.export") }}
      </button>
    </div>
    <main class="content">
      <section class="panel">
        <div class="ph">{{ t("debug.file") }}</div>
        <div class="kv wide">
          <span class="kk">{{ t("debug.k.path") }}</span><span class="vv span3">{{ log?.path ?? "–" }}</span>
          <span class="kk">{{ t("debug.k.created") }}</span><span class="vv">{{ when(log?.file?.createdMs ?? null) }}</span>
          <span class="kk">{{ t("debug.k.modified") }}</span><span class="vv">{{ when(log?.file?.modifiedMs ?? null) }}</span>
          <span class="kk">{{ t("debug.k.size") }}</span><span class="vv">{{ log?.file ? mb(log.file.size) : "–" }}</span>
          <span class="kk">{{ t("debug.k.readTo") }}</span><span class="vv">{{ log?.file ? mb(log.file.readTo) : "–" }}</span>
        </div>
      </section>

      <section class="panel">
        <div class="ph">
          {{ t("unlocks.title") }} <span class="cnt">{{ unlocks.length }}</span>
          <div class="spacer" />
          <button v-for="s in STATES" :key="s.state" type="button" class="chip" :class="{ active: shown.has(s.state) }" @click="toggleState(s.state)">{{ t(`state.${s.state}`) }}</button>
        </div>
        <div v-if="!unlockRows.length" class="empty-line">{{ report ? t("debug.noUnlocks") : t("state.loading") }}</div>
        <table v-else>
          <colgroup>
            <col style="width: 150px" />
            <col style="width: 220px" />
            <col />
            <col style="width: 130px" />
            <col style="width: 90px" />
          </colgroup>
          <thead>
            <tr>
              <th>{{ t("col.at") }}</th>
              <th>{{ t("debug.col.logName") }}</th>
              <th>{{ t("debug.col.catalog") }}</th>
              <th>{{ t("col.state") }}</th>
              <th>{{ t("col.source") }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="u in unlockRows" :key="u.name">
              <td class="mono">{{ when(u.at) }}</td>
              <td class="mono white">{{ u.name }}</td>
              <td>{{ u.labels.join(" · ") || "–" }}</td>
              <td><span class="tag" :class="STATE_CLASS[u.state]">{{ t(`state.${u.state}`) }}</span></td>
              <td>{{ t(u.backup ? "debug.source.backup" : "debug.source.log") }}</td>
            </tr>
          </tbody>
        </table>
      </section>

      <section class="panel">
        <div class="ph">{{ t("col.location") }}</div>
        <div class="kv wide">
          <span class="kk">{{ t("debug.k.logged") }}</span><span class="vv">{{ logged ?? "–" }}</span>
          <span class="kk">{{ t("debug.k.inCatalog") }}</span>
          <span v-if="!logged" class="vv">–</span>
          <span v-else-if="resolve(logged) === undefined">{{ t("state.loading") }}</span>
          <span v-else class="vv">
            {{ resolve(logged) ?? "–" }}
            <span class="tag" :class="resolve(logged) ? 'ok' : 'warn'">{{ t(resolve(logged) ? "debug.selectable" : "debug.notSelectable") }}</span>
          </span>
          <span class="kk">{{ t("debug.k.auto") }}</span>
          <span><span class="tag" :class="report?.autoLocation ? 'ok' : ''">{{ report ? t(report.autoLocation ? "debug.on" : "debug.off") : "–" }}</span></span>
          <span class="kk">{{ t("debug.k.picked") }}</span><span class="vv">{{ report?.picked ?? "–" }}</span>
        </div>
        <div class="sub-h">{{ t("debug.locationLines") }} <span class="cnt">{{ locationLines.length }}</span></div>
        <div v-if="!locationLines.length" class="empty-line">{{ t("debug.noLocations") }}</div>
        <table v-else>
          <colgroup>
            <col style="width: 150px" />
            <col style="width: 240px" />
            <col />
            <col style="width: 130px" />
          </colgroup>
          <thead>
            <tr>
              <th>{{ t("debug.col.time") }}</th>
              <th>{{ t("debug.col.key") }}</th>
              <th>{{ t("debug.col.locationCatalog") }}</th>
              <th>{{ t("col.state") }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(l, i) in locationLines" :key="i">
              <td class="mono">{{ when(l.at) }}</td>
              <td class="mono white">{{ l.key }}</td>
              <td>{{ resolve(l.key) ?? "–" }}</td>
              <td>
                <span v-if="resolve(l.key) === undefined" class="tag">{{ t("state.loading") }}</span>
                <span v-else class="tag" :class="resolve(l.key) ? 'ok' : 'warn'">{{ t(resolve(l.key) ? "debug.selectable" : "debug.notSelectable") }}</span>
              </td>
            </tr>
          </tbody>
        </table>
      </section>
    </main>
  </section>
</template>
