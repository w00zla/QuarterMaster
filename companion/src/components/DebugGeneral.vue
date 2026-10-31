<script setup lang="ts">
// The debug window's General tab: the app (version, platform, setup or standalone exe, server, connection,
// user), its folders (each opens in the file manager), the catalog as loaded (when, entries per language,
// the copy kept on disk with its ETag) and the player's language pack (user.cfg's language, the global.ini
// the game reads, how many of the texts asked for it had). The app's side comes from the Rust side
// (debug_info, re-read when the config or the catalog changes), connection, user and catalog from the main
// window ("general-report", debugReport.ts).
import { onMounted, ref } from "vue";
import { emit, listen } from "@tauri-apps/api/event";
import Icon from "../../../adminapp/src/components/Icon.vue";
import Tooltip from "../../../adminapp/src/components/Tooltip.vue";
import { appInfo, debugInfo, openFolder, type AppFolder, type DebugInfo } from "../backend";
import type { GeneralReport } from "../debugReport";
import { t } from "../i18n";
import { errorText, toast, toastError } from "../toasts";

const app = ref<Awaited<ReturnType<typeof appInfo>> | null>(null);
const info = ref<DebugInfo | null>(null);
const report = ref<GeneralReport | null>(null);

const load = async () => {
  info.value = await debugInfo();
};

onMounted(async () => {
  try {
    app.value = await appInfo();
    await load();
    await listen("config-changed", () => void load().catch(() => undefined));
    await listen<GeneralReport>("general-report", (e) => {
      // A catalog loaded again: its copy on disk too
      if (e.payload.catalog?.atMs !== report.value?.catalog?.atMs) void load().catch(() => undefined);
      report.value = e.payload;
    });
    await emit("general-report-request");
  } catch (e) {
    toast(errorText(e), "error");
  }
});

const pad = (n: number) => String(n).padStart(2, "0");
// Local time as "2026-10-07 14:05:09" in every language
function when(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return "–";
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
const size = (bytes: number | null) => (bytes === null ? "–" : bytes < 1e6 ? `${(bytes / 1e3).toFixed(1)} KB` : `${(bytes / 1e6).toFixed(1)} MB`);

const folders = (i: DebugInfo): { which: AppFolder; key: "debug.k.config" | "debug.k.logDir" | "debug.k.cacheDir" | "debug.k.gameDir"; path: string }[] => [
  { which: "config", key: "debug.k.config", path: i.configFile },
  { which: "log", key: "debug.k.logDir", path: i.logDir },
  { which: "cache", key: "debug.k.cacheDir", path: i.cacheDir },
  { which: "game", key: "debug.k.gameDir", path: i.gameDir },
];
const open = (which: AppFolder) => void openFolder(which).catch(toastError);
const counts = (lang: string) => report.value?.catalog?.counts.find((c) => c.lang === lang);
</script>

<template>
  <section class="pane">
    <main class="content">
      <section class="panel">
        <div class="ph">{{ t("debug.app") }}</div>
        <div class="kv wide">
          <span class="kk">{{ t("debug.k.version") }}</span><span class="vv">{{ app ? `v${app.version}` : "–" }}</span>
          <span class="kk">{{ t("debug.k.platform") }}</span>
          <span class="vv">{{ app ? `${app.platform} · ${t(app.updater ? "debug.build.setup" : "debug.build.standalone")}` : "–" }}</span>
          <span class="kk">{{ t("debug.k.server") }}</span><span class="vv">{{ info?.server || "–" }}</span>
          <span class="kk">{{ t("debug.k.user") }}</span><span class="vv">{{ report?.user ?? "–" }}</span>
          <span class="kk">{{ t("debug.k.connection") }}</span>
          <span class="span3"><span v-if="report" class="tag" :class="report.connected ? 'ok' : 'warn'">{{ report.connection }}</span><template v-else>–</template></span>
        </div>
      </section>

      <section class="panel">
        <div class="ph">{{ t("debug.folders") }}</div>
        <div class="kv">
          <template v-for="f in info ? folders(info) : []" :key="f.which">
            <span class="kk">{{ t(f.key) }}</span>
            <span class="vv">
              <span class="path">{{ f.path || "–" }}</span>
              <Tooltip :text="t('debug.openFolder')">
                <button type="button" class="icon-btn" :disabled="!f.path" @click="open(f.which)"><Icon name="external" :size="13" /></button>
              </Tooltip>
            </span>
          </template>
        </div>
      </section>

      <section class="panel">
        <div class="ph">
          {{ t("debug.col.catalog") }}
          <span class="right">{{ report?.catalog ? when(report.catalog.atMs) : t("debug.catalog.pending") }}</span>
        </div>
        <table>
          <colgroup>
            <col style="width: 70px" />
            <col style="width: 90px" />
            <col style="width: 70px" />
            <col style="width: 80px" />
            <col style="width: 80px" />
            <col style="width: 150px" />
            <col />
          </colgroup>
          <thead>
            <tr>
              <th>{{ t("debug.col.lang") }}</th>
              <th class="num">{{ t("debug.col.materials") }}</th>
              <th class="num">{{ t("debug.col.locations") }}</th>
              <th class="num">{{ t("debug.col.blueprints") }}</th>
              <th class="num">{{ t("debug.k.size") }}</th>
              <th>{{ t("debug.k.modified") }}</th>
              <th>ETag</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="c in info?.catalog ?? []" :key="c.lang">
              <td class="mono white">{{ c.lang }}</td>
              <td class="num">{{ counts(c.lang)?.materials ?? "–" }}</td>
              <td class="num">{{ counts(c.lang)?.locations ?? "–" }}</td>
              <td class="num">{{ counts(c.lang)?.blueprints ?? "–" }}</td>
              <td class="num">{{ size(c.file.size) }}</td>
              <td class="mono">{{ when(c.file.modifiedMs) }}</td>
              <td class="mono">{{ c.etag ?? "–" }}</td>
            </tr>
          </tbody>
        </table>
      </section>

      <section class="panel">
        <div class="ph">
          {{ t("debug.pack") }}
          <span v-if="info" class="tag" :class="info.pack.size !== null ? 'ok' : ''">{{ t(info.pack.size !== null ? "debug.pack.found" : "debug.pack.missing") }}</span>
        </div>
        <div class="kv wide">
          <span class="kk">{{ t("debug.k.path") }}</span><span class="vv span3">{{ info?.pack.path ?? "–" }}</span>
          <span class="kk">{{ t("debug.k.language") }}</span><span class="vv">{{ info ? info.language ?? t("debug.language.none") : "–" }}</span>
          <span class="kk">{{ t("debug.k.texts") }}</span>
          <span class="vv">{{ report?.catalog ? t("debug.texts", { found: report.catalog.packFound, keys: report.catalog.packKeys }) : "–" }}</span>
          <span class="kk">{{ t("debug.k.size") }}</span><span class="vv">{{ info ? size(info.pack.size) : "–" }}</span>
          <span class="kk">{{ t("debug.k.modified") }}</span><span class="vv">{{ when(info?.pack.modifiedMs) }}</span>
        </div>
      </section>
    </main>
  </section>
</template>

<style scoped>
.path {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}

.icon-btn {
  width: 18px;
  height: 18px;
}
</style>
