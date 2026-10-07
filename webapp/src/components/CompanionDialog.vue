<script setup lang="ts">
// The companion app as an app card: logo, name, version and the downloads of the release the server
// hands out (the browser's own platform first and primary); below it a bar with its Access Key (the
// API token; shown once when created, a new one replaces the old).
import { computed, onMounted, ref } from "vue";
import type { ApiTokenCreated, ApiTokenInfo, CompanionInfo, CompanionPlatform } from "../../../src/webapp/api-types";
import Icon from "../../../adminapp/src/components/Icon.vue";
// Exact sizes (72 px, 144 px for 2x screens) from assets/logo.png
import logo from "../assets/logo-72.png";
import logo2x from "../assets/logo-144.png";
import { api } from "../api";
import { t } from "../i18n";
import { toast, toastError } from "../toasts";
import ConfirmDialog, { type ConfirmButton } from "./ConfirmDialog.vue";

const emit = defineEmits<{ close: [] }>();

const keyInfo = ref<ApiTokenInfo | null>(null);
// The key just created: shown until the dialog closes, never again
const newKey = ref<string | null>(null);
const release = ref<CompanionInfo | null>(null);
const busy = ref(false);

const buttons: ConfirmButton[] = [{ label: t("common.close"), kind: "outline", value: "close" }];
const PLATFORM: Record<CompanionPlatform, { name: string; type: string }> = {
  windows: { name: "Windows", type: "zip" },
  linux: { name: "Linux", type: "AppImage" },
};
// The browser's platform, for the primary download
const ua = navigator.userAgent;
const own: CompanionPlatform | null = /Windows/.test(ua) ? "windows" : /Linux/.test(ua) && !/Android/.test(ua) ? "linux" : null;
// The own platform first
const downloads = computed(() => [...(release.value?.downloads ?? [])].sort((a, b) => Number(b.platform === own) - Number(a.platform === own)));

// "2026-10-07" in every language
const pad = (n: number) => String(n).padStart(2, "0");
const date = (iso: string) => {
  const d = new Date(iso);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
const keyText = computed(() => {
  const info = keyInfo.value;
  if (!info?.createdAt) return "";
  const created = t("companion.keyCreated", { date: date(info.createdAt) });
  return info.lastUsedAt ? `${created} · ${t("companion.keyUsed", { date: date(info.lastUsedAt) })}` : created;
});
const size = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

onMounted(async () => {
  try {
    [keyInfo.value, release.value] = [await api<ApiTokenInfo>("/token"), await api<CompanionInfo>("/companion")];
  } catch (e) {
    toastError(e);
  }
});

async function createKey() {
  busy.value = true;
  try {
    newKey.value = (await api<ApiTokenCreated>("/token", { method: "POST", body: {} })).token;
    keyInfo.value = await api<ApiTokenInfo>("/token");
  } catch (e) {
    toastError(e);
  } finally {
    busy.value = false;
  }
}

async function copyKey() {
  if (!newKey.value) return;
  try {
    await navigator.clipboard.writeText(newKey.value);
    toast(t("companion.copied"));
  } catch (e) {
    toastError(e);
  }
}
</script>

<template>
  <ConfirmDialog :title="t('companion.title')" icon="desktop" :buttons="buttons" @choose="emit('close')">
    <div class="app-card">
      <img class="logo" :src="logo" :srcset="`${logo} 1x, ${logo2x} 2x`" alt="" />
      <div class="app-main">
        <div class="app-name">
          Quartermaster Companion
          <span v-if="release?.version" class="tag mono">v{{ release.version }}</span>
        </div>
        <template v-if="release?.version">
          <a
            v-for="d in downloads"
            :key="d.platform"
            class="btn small get"
            :class="d.platform === own ? 'primary' : 'outline'"
            :href="d.url"
            download
          >
            <Icon name="imports" :size="14" /> {{ PLATFORM[d.platform].name }} · {{ PLATFORM[d.platform].type }} · {{ size(d.size) }}
          </a>
        </template>
        <div v-else-if="release" class="faint">{{ t("companion.noRelease") }}</div>
      </div>
    </div>

    <div class="key-bar">
      <div class="key-line">
        <span class="key-label">{{ t("companion.key") }}</span>
        <span v-if="keyInfo?.createdAt" class="tag ok">{{ t("companion.keyActive") }}</span>
        <span v-else-if="keyInfo" class="tag">{{ t("companion.keyNone") }}</span>
        <span class="faint dates">{{ keyText }}</span>
        <button type="button" class="btn small outline" :disabled="busy || !keyInfo" @click="createKey">
          <Icon name="refresh" :size="14" /> {{ t(keyInfo?.createdAt ? "companion.keyRecreate" : "companion.keyCreate") }}
        </button>
      </div>
      <div v-if="newKey" class="key-box">
        <input class="key" type="text" :value="newKey" readonly spellcheck="false" @focus="($event.target as HTMLInputElement).select()" />
        <button type="button" class="icon-btn" :title="t('companion.copy')" @click="copyKey"><Icon name="copy" :size="14" /></button>
      </div>
    </div>
  </ConfirmDialog>
</template>

<style scoped>
/* The app: logo left, name, version and downloads right */
.app-card {
  display: flex;
  align-items: flex-start;
  gap: 16px;
  padding-bottom: 16px;
  border-bottom: 1px solid var(--border-dim);
}

.logo {
  width: 72px;
  height: 72px;
  flex-shrink: 0;
  display: block;
}

.app-main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 8px;
}

.app-name {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 16px;
  font-weight: 600;
}

.get {
  text-decoration: none;
}

/* The Access Key below, set apart by the line above */
.key-bar {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding-top: 14px;
}

.key-line {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 10px;
  min-height: var(--h-chip-sm);
}

/* Like a table's column head */
.key-label {
  color: var(--text-2);
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.1em;
  text-transform: uppercase;
}

.dates {
  flex: 1;
  min-width: 0;
  font-size: 13px;
}

/* The new key, once: a wide mono field with the copy button inside */
.key-box {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 6px 6px 12px;
  background: var(--bg-base);
  border: 1px solid var(--accent);
  border-radius: var(--radius-control);
}

.key {
  flex: 1;
  min-width: 0;
  border: none;
  background: transparent;
  color: var(--text);
  font-family: var(--font-mono);
  font-size: 13px;
  outline: none;
}
</style>
