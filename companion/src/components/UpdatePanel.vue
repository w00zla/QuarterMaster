<script setup lang="ts">
// Shown instead of everything else while the server calls this version outdated: installed and
// required version, and the download of the new one to a folder the user picks (with progress).
import { computed, onMounted, onUnmounted, ref } from "vue";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { downloadDir, join } from "@tauri-apps/api/path";
import { save } from "@tauri-apps/plugin-dialog";
import type { CompanionOutdated } from "../../../src/webapp/api-types";
import Icon from "../../../adminapp/src/components/Icon.vue";
import { downloadUpdate } from "../backend";
import { langRef, t } from "../i18n";
import { errorText, toast } from "../toasts";

const props = defineProps<{ outdated: CompanionOutdated; current: string; url: string | null }>();

const downloading = ref(false);
const progress = ref<{ done: number; total: number | null } | null>(null);
const pct = computed(() => (progress.value?.total ? (progress.value.done / progress.value.total) * 100 : 0));
const mb = (bytes: number) => (bytes / 1048576).toLocaleString(langRef.value, { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const amount = computed(() => {
  if (!progress.value) return "";
  const { done, total } = progress.value;
  return total ? `${mb(done)} / ${mb(total)} MB` : `${mb(done)} MB`;
});

async function download() {
  if (!props.url || downloading.value) return;
  const file = decodeURIComponent(props.url.split("/").pop() ?? "");
  const dest = await save({ defaultPath: await join(await downloadDir(), file) });
  if (!dest) return;
  downloading.value = true;
  progress.value = null;
  try {
    await downloadUpdate(props.url, dest);
    toast(t("outdated.saved", { path: dest }));
  } catch (e) {
    // Also token and network refusals: this download does not go through the connection state
    toast(errorText(e), "error");
  } finally {
    downloading.value = false;
  }
}

let unlisten: UnlistenFn | undefined;
onMounted(async () => {
  unlisten = await listen<{ done: number; total: number | null }>("download-progress", (e) => (progress.value = e.payload));
});
onUnmounted(() => unlisten?.());
</script>

<template>
  <section class="panel update">
    <div class="head">
      <Icon name="warning" :size="16" />
      <span class="head-title">{{ t("outdated.title") }}</span>
    </div>
    <div class="body">
      <div class="versions">
        <span class="key">{{ t("outdated.installed") }}</span>
        <span class="mono">{{ current }}</span>
        <span class="key">{{ t("outdated.required") }}</span>
        <span class="mono required">{{ outdated.version }}</span>
      </div>
      <!-- Always there (no jump when a download starts) -->
      <div class="progress" :class="{ idle: !downloading }">
        <div class="bar"><div class="fill" :style="{ width: `${pct}%` }" /></div>
        <span class="amount mono">{{ amount }}</span>
      </div>
      <button v-if="url" type="button" class="btn primary" :disabled="downloading" @click="download">
        <Icon name="imports" :size="14" /> {{ t("outdated.download") }}
      </button>
    </div>
  </section>
</template>

<style scoped>
.update {
  max-width: 440px;
  width: 100%;
  margin: 48px auto 0;
}

.body {
  display: flex;
  flex-direction: column;
  gap: 16px;
  padding: 16px;
}

.versions {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 6px 16px;
  font-size: 13px;
}

.key {
  color: var(--text-2);
}

.required {
  color: var(--accent);
  font-weight: 600;
}

.progress {
  display: flex;
  align-items: center;
  gap: 12px;
  min-height: 18px;
}

.progress.idle {
  visibility: hidden;
}

.bar {
  flex: 1;
  height: 4px;
  border-radius: 2px;
  background: var(--bg-surface-2);
  overflow: hidden;
}

.fill {
  height: 100%;
  border-radius: 2px;
  background: var(--accent);
  box-shadow: 0 0 6px var(--accent);
  transition: width 0.15s ease-out;
}

.amount {
  font-size: 12px;
  color: var(--text-2);
  white-space: nowrap;
}

.btn {
  align-self: flex-start;
}
</style>
