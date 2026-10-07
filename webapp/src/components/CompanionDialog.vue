<script setup lang="ts">
// The companion app: its Access Key (the API token; shown once when created, a new one replaces the
// old) and the download of the release the server hands out, with its version.
import { computed, onMounted, ref } from "vue";
import type { ApiTokenCreated, ApiTokenInfo, CompanionInfo } from "../../../src/webapp/api-types";
import Icon from "../../../adminapp/src/components/Icon.vue";
import { api } from "../api";
import { lang, t } from "../i18n";
import { toast, toastError } from "../toasts";
import ConfirmDialog, { type ConfirmButton } from "./ConfirmDialog.vue";

const emit = defineEmits<{ close: [] }>();

const keyInfo = ref<ApiTokenInfo | null>(null);
// The key just created: shown until the dialog closes, never again
const newKey = ref<string | null>(null);
const release = ref<CompanionInfo | null>(null);
const busy = ref(false);

const buttons: ConfirmButton[] = [{ label: t("common.close"), kind: "outline", value: "close" }];
const PLATFORM = { windows: "Windows (zip)", linux: "Linux (AppImage)" } as const;

const date = (iso: string) => new Date(iso).toLocaleDateString(lang.value);
const keyText = computed(() => {
  const info = keyInfo.value;
  if (!info?.createdAt) return t("companion.keyNone");
  const created = t("companion.keyCreated", { date: date(info.createdAt) });
  return info.lastUsedAt ? `${created}, ${t("companion.keyUsed", { date: date(info.lastUsedAt) })}` : created;
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
  <ConfirmDialog :title="t('companion.title')" icon="link" :buttons="buttons" @choose="emit('close')">
    <div class="form single flush">
      <div class="field">
        {{ t("companion.download") }}
        <template v-if="release?.version">
          <div class="faint">{{ t("companion.version", { version: release.version }) }}</div>
          <a v-for="d in release.downloads" :key="d.platform" class="btn outline download" :href="d.url" download>
            <Icon name="imports" :size="14" /> {{ PLATFORM[d.platform] }} <span class="faint">· {{ size(d.size) }}</span>
          </a>
        </template>
        <div v-else-if="release" class="faint">{{ t("companion.noRelease") }}</div>
      </div>
      <div class="field">
        {{ t("companion.key") }}
        <div v-if="newKey" class="line">
          <input class="input key" type="text" :value="newKey" readonly spellcheck="false" @focus="($event.target as HTMLInputElement).select()" />
          <button type="button" class="btn outline" :title="t('companion.copy')" @click="copyKey"><Icon name="copy" :size="14" /></button>
        </div>
        <div v-else class="line">
          <span class="status faint">{{ keyText }}</span>
          <button type="button" class="btn outline" :disabled="busy || !keyInfo" @click="createKey">
            {{ t(keyInfo?.createdAt ? "companion.keyRecreate" : "companion.keyCreate") }}
          </button>
        </div>
      </div>
    </div>
  </ConfirmDialog>
</template>

<style scoped>
.line {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: var(--h-control);
}

.status {
  flex: 1;
  min-width: 0;
}

.key {
  flex: 1;
  min-width: 0;
  font-family: var(--font-mono);
}

.download {
  justify-content: flex-start;
  text-decoration: none;
}
</style>
