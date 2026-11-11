<script setup lang="ts">
// The companion app as an app card: logo, name and the link to its releases on GitHub; below it a bar with
// its Access Key (the API token; shown once when created, a new one replaces the old).
import { computed, onMounted, ref } from "vue";
import type { ApiTokenCreated, ApiTokenInfo } from "../../../src/webapp/api-types";
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
const busy = ref(false);

const RELEASES = "https://github.com/w00zla/quartermaster/releases";
const buttons: ConfirmButton[] = [{ label: t("common.close"), kind: "outline", value: "close" }];

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

onMounted(async () => {
  try {
    keyInfo.value = await api<ApiTokenInfo>("/token");
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
      <div class="app-head">
        <img class="logo" :src="logo" :srcset="`${logo} 1x, ${logo2x} 2x`" alt="" />
        <div class="app-main">
          <div class="app-name">Quartermaster Companion</div>
          <a class="btn small primary get" :href="RELEASES" target="_blank" rel="noopener noreferrer">
            <Icon name="external" :size="14" /> {{ t("companion.releases") }}
          </a>
        </div>
      </div>
    </div>

    <div class="key-bar">
      <div class="key-line">
        <span class="key-label">{{ t("companion.key") }}</span>
        <span v-if="keyInfo?.createdAt" class="tag ok">{{ t("companion.keyActive") }}</span>
        <span v-else-if="keyInfo" class="tag">{{ t("companion.keyNone") }}</span>
        <span class="faint dates">{{ keyText }}</span>
        <button type="button" class="btn small outline" :disabled="busy || !keyInfo" @click="createKey">
          <Icon name="refresh" :size="14" />
          <span class="swap">
            <span :class="{ hidden: !keyInfo?.createdAt }">{{ t("companion.keyRecreate") }}</span><span :class="{ hidden: keyInfo?.createdAt }">{{ t("companion.keyCreate") }}</span>
          </span>
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
/* The app: logo left of name and the releases link */
.app-card {
  padding-bottom: 16px;
  border-bottom: 1px solid var(--border-dim);
}

.app-head {
  display: flex;
  align-items: center;
  gap: 16px;
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
