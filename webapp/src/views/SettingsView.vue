<script setup lang="ts">
// The settings of the singleuser variant (/settings): the game folder, the game data, the UEX trade data and the app.
// Everything comes from /api/local/*; the decisions (tags, what a field commit does) are in settingsLogic.ts.
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import Icon from "../../../adminapp/src/components/Icon.vue";
import ConfirmDialog, { type ConfirmButton } from "../components/ConfirmDialog.vue";
import Dropdown from "../components/Dropdown.vue";
import ImportDialog from "../components/ImportDialog.vue";
import LangSelect from "../components/LangSelect.vue";
import { ApiError } from "../api";
import { lang, t } from "../i18n";
import { checkData, data, loadSettings, refreshData, refreshUex, saveSettings, settings, uex } from "../local";
import { dayTime, megabytes, shortTime } from "../localTime";
import { me, saveProfile } from "../session";
import {
  dataTag, folderView, gameDirChange, isBusy, KEY_MASK, keyDecision, nextFetch, packTag, uexRefused, uexTag,
  type TagModel,
} from "../settingsLogic";
import { shell } from "../shell";
import { toastError } from "../toasts";

const s = computed(() => settings.value);
const tagClass = (tag: TagModel) => (tag.kind === "off" ? "" : tag.kind);

// --- game folder ---
const dirDraft = ref("");
const rejected = ref(false);
const dirBusy = ref(false);
// A server change replaces the field only while it holds no unsaved edit
watch(() => s.value?.gameDir, (dir, old) => {
  if (dirDraft.value.trim() === (old ?? "")) dirDraft.value = dir ?? "";
}, { immediate: true });

const folder = computed(() => (s.value ? folderView(s.value.gameFolder, rejected.value) : null));

async function applyDir(value: string | null) {
  dirBusy.value = true;
  try {
    await saveSettings({ gameDir: value });
    rejected.value = false;
    // As the server stored it (it may have tidied the path)
    dirDraft.value = settings.value?.gameDir ?? "";
  } catch (e) {
    // 422: the folder holds no game; the saved setting stays
    if (e instanceof ApiError && e.status === 422) rejected.value = true;
    else toastError(e);
  } finally {
    dirBusy.value = false;
  }
}

/** Enter, or the field loses focus: a changed value is applied. */
function commitDir() {
  if (!s.value || dirBusy.value) return;
  const change = gameDirChange(dirDraft.value, s.value.gameDir);
  if (change.apply) void applyDir(change.value);
}

async function browse() {
  const dir = await shell.pickFolder();
  if (!dir) return;
  dirDraft.value = dir;
  commitDir();
}

// --- game data ---
const importing = ref(false);
const busy = computed(() => isBusy(data.value));
const newAmount = computed(() => {
  const p = data.value?.progress;
  return p ? megabytes(p.done, p.total, lang.value) : "";
});

async function check() {
  try {
    await checkData();
  } catch (e) {
    toastError(e);
  }
}

// --- UEX ---
const keyDraft = ref("");
const keyBusy = ref(false);
const removing = ref(false);
watch(() => s.value?.uexKeySet, (set) => (keyDraft.value = set ? KEY_MASK : ""), { immediate: true });

const decision = computed(() => keyDecision(keyDraft.value, !!s.value?.uexKeySet));
const refused = computed(() => !!s.value && uexRefused(s.value, uex.value) && decision.value === "none");

async function submitKey() {
  if (decision.value === "none" || keyBusy.value) return;
  if (decision.value === "remove") {
    removing.value = true;
    return;
  }
  await storeKey(keyDraft.value.trim());
}

async function storeKey(key: string) {
  keyBusy.value = true;
  try {
    await saveSettings({ uexKey: key });
    keyDraft.value = s.value?.uexKeySet ? KEY_MASK : "";
  } catch (e) {
    toastError(e);
  } finally {
    keyBusy.value = false;
  }
}

const removeButtons: ConfirmButton[] = [
  { label: t("common.cancel"), kind: "outline", value: "cancel" },
  { label: t("uex.remove"), kind: "danger", value: "remove", icon: "trash" },
];

async function removeChoice(value: string) {
  removing.value = false;
  if (value === "remove") await storeKey("");
}

const intervals = computed(() => [15, 30, 60].map((n) => ({ value: String(n), label: t("uex.minutes", { n }) })));

async function setIntervalMinutes(value: string) {
  try {
    await saveSettings({ uexIntervalMinutes: Number(value) as 15 | 30 | 60 });
  } catch (e) {
    toastError(e);
  }
}

// The pull's state: quickly while one runs, else now and then (the times move on)
let timer: ReturnType<typeof setTimeout> | undefined;
function pollUex() {
  timer = setTimeout(async () => {
    await refreshUex();
    pollUex();
  }, uex.value?.phase === "pulling" ? 1500 : 30_000);
}

// --- app ---
async function setAuto(e: Event) {
  const box = e.target as HTMLInputElement;
  try {
    await saveSettings({ autoUpdate: box.checked });
  } catch (err) {
    box.checked = !!s.value?.autoUpdate;
    toastError(err);
  }
}

const langChoice = computed(() => me.value?.langOverride ?? "auto");
async function setLang(value: string) {
  try {
    await saveProfile({ langOverride: value === "de" || value === "en" ? value : null });
  } catch (e) {
    toastError(e);
  }
}

onMounted(() => {
  void loadSettings();
  void refreshData();
  void refreshUex().then(pollUex);
});
onUnmounted(() => clearTimeout(timer));
</script>

<template>
  <div class="page">
    <div v-if="!s || !folder" class="empty-line">{{ t("common.loading") }}</div>
    <div v-else class="grid">
      <!-- Game folder -->
      <section class="panel unclipped" aria-labelledby="h-game">
        <div class="head">
          <Icon name="folder" :size="16" />
          <h2 id="h-game" class="head-title">{{ t("folder.title") }}</h2>
          <span v-if="folder.tag" class="tag" :class="tagClass(folder.tag)">{{ t(folder.tag.text) }}</span>
        </div>
        <div class="body">
          <div class="srow nowrap">
            <label class="k" for="game-dir">{{ t("folder.folder") }}</label>
            <input
              id="game-dir"
              v-model="dirDraft"
              class="input mono grow"
              :class="{ invalid: folder.message, 'call-out': folder.needsFolder && !shell.available }"
              type="text"
              autocomplete="off"
              spellcheck="false"
              :disabled="s.overridden.gameDir"
              @input="rejected = false"
              @keydown.enter.prevent="commitDir"
              @blur="commitDir"
            />
            <button v-if="shell.available" class="btn" :class="folder.needsFolder ? 'primary' : 'outline'" type="button" :disabled="s.overridden.gameDir" @click="browse">
              <Icon name="folder" :size="14" /> {{ t("folder.browse") }}
            </button>
          </div>
          <div class="srow msg" :class="{ hidden: !folder.message }" :aria-hidden="!folder.message">
            <span class="k" />
            <span class="err-text">{{ t("folder.message") }}</span>
          </div>
          <div class="srow">
            <span class="k">{{ t("folder.version") }}</span>
            <span class="ver-chip" :class="{ none: !s.gameFolder.gameVersion }">{{ s.gameFolder.gameVersion ?? "–" }}</span>
          </div>
          <div class="srow">
            <span class="k">{{ t("folder.pack") }}</span>
            <span class="tag" :class="tagClass(packTag(s.languagePack))">{{ t(packTag(s.languagePack).text) }}</span>
          </div>
        </div>
      </section>

      <!-- Game data -->
      <section class="panel unclipped" aria-labelledby="h-data">
        <div class="head">
          <Icon name="database" :size="16" />
          <h2 id="h-data" class="head-title">{{ t("data.title") }}</h2>
          <span v-if="dataTag(data)" class="tag" :class="tagClass(dataTag(data)!)">{{ t(dataTag(data)!.text) }}</span>
        </div>
        <div class="body">
          <div class="srow">
            <span class="k">{{ t("data.installed") }}</span>
            <span class="ver-chip" :class="{ none: !data?.installed }">{{ data?.installed?.gameLabel ?? "–" }}</span>
          </div>
          <!-- While busy the amount in place of the check time: one row either way -->
          <div v-if="busy" class="srow">
            <span class="k">{{ t("data.new") }}</span>
            <span class="amount mono">{{ newAmount || "–" }}</span>
          </div>
          <div v-else class="srow">
            <span class="k">{{ t("data.checked") }}</span>
            <span class="v">{{ dayTime(data?.last?.at, new Date(), lang) || "–" }}</span>
          </div>
          <div class="srow end">
            <button class="btn outline" type="button" :disabled="busy" @click="importing = true">
              <Icon name="imports" :size="14" /> {{ t("data.import") }}
            </button>
            <button class="btn outline" type="button" :disabled="busy" @click="check">
              <Icon name="search" :size="14" /> {{ t("data.check") }}
            </button>
          </div>
        </div>
      </section>

      <!-- UEX -->
      <section class="panel unclipped" aria-labelledby="h-uex">
        <div class="head">
          <Icon name="trend" :size="16" />
          <h2 id="h-uex" class="head-title">{{ t("uex.title") }}</h2>
          <span class="tag" :class="tagClass(uexTag(s, uex))">{{ t(uexTag(s, uex).text) }}</span>
        </div>
        <form class="body" @submit.prevent="submitKey">
          <div class="srow nowrap">
            <label class="k" for="uex-key">{{ t("uex.key") }}</label>
            <input
              id="uex-key"
              v-model="keyDraft"
              class="input mono grow"
              :class="{ invalid: refused }"
              type="password"
              autocomplete="off"
              spellcheck="false"
              :disabled="s.overridden.uexKey"
              @focus="($event.target as HTMLInputElement).select()"
            />
            <button class="btn outline" type="submit" :disabled="decision === 'none' || keyBusy || s.overridden.uexKey">
              <Icon name="check" :size="14" /> {{ t("common.save") }}
            </button>
          </div>
          <div class="srow msg" :class="{ hidden: !refused }" :aria-hidden="!refused">
            <span class="k" />
            <span class="err-text">{{ t("uex.rejected") }}</span>
          </div>
          <div class="srow">
            <span class="k">{{ t("uex.every") }}</span>
            <Dropdown :model-value="String(s.uexIntervalMinutes)" variant="outline" :options="intervals" :disabled="!s.uexKeySet" :title="t('uex.every')" @update:model-value="setIntervalMinutes" />
          </div>
          <div class="srow">
            <span class="k">{{ t("uex.last") }}</span>
            <span class="v time">{{ shortTime(uex?.lastPull, new Date(), lang) || "–" }}</span>
            <span class="k2">{{ t("uex.next") }}</span>
            <span class="v time">{{ shortTime(nextFetch(uex), new Date(), lang) || "–" }}</span>
          </div>
          <div class="srow">
            <a href="https://uexcorp.space" target="_blank" rel="noopener noreferrer" class="ext"><Icon name="external" :size="14" /> uexcorp.space</a>
          </div>
        </form>
      </section>

      <!-- App -->
      <section class="panel unclipped" aria-labelledby="h-app">
        <div class="head">
          <Icon name="settings" :size="16" />
          <h2 id="h-app" class="head-title">{{ t("app.title") }}</h2>
        </div>
        <div class="body">
          <div class="srow">
            <span class="k">{{ t("app.version") }}</span>
            <span class="ver-chip">v{{ s.appVersion }}</span>
          </div>
          <div class="srow">
            <label class="k" for="auto-update">{{ t("app.autoUpdate") }}</label>
            <input id="auto-update" class="switch" type="checkbox" role="switch" :checked="s.autoUpdate" :disabled="s.overridden.autoUpdate" @change="setAuto" />
          </div>
          <!-- Only where the desktop shell offers app updates -->
          <div v-if="shell.updateAvailable" class="srow end">
            <button class="btn outline" type="button" @click="shell.openUpdate()">
              <Icon name="imports" :size="14" /> {{ t("update.button") }}
            </button>
          </div>
          <div class="srow">
            <span class="k">{{ t("lang.title") }}</span>
            <LangSelect :model-value="langChoice" variant="outline" @update:model-value="setLang" />
          </div>
        </div>
      </section>
    </div>

    <ImportDialog v-if="importing" @close="importing = false" />
    <ConfirmDialog v-if="removing" :title="t('uex.removeTitle')" icon="lock" :buttons="removeButtons" @choose="removeChoice" />
  </div>
</template>

<style scoped>
.grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(440px, 100%), 1fr));
  gap: 12px;
  align-items: start;
}

/* The head is as high with a tag as without one (a tag appearing must not move anything) */
.head {
  min-height: 53px;
  box-sizing: border-box;
}

.head-title {
  margin: 0;
}

.body {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 16px;
}

.srow {
  min-height: 32px;
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 12px;
}

.srow.nowrap {
  flex-wrap: nowrap;
}

.srow.end {
  justify-content: flex-end;
}

.srow.msg {
  min-height: 18px;
  margin-top: -4px;
}

.hidden {
  visibility: hidden;
}

.k {
  width: 132px;
  flex-shrink: 0;
  font-size: 12px;
  color: var(--text-2);
}

.k2 {
  font-size: 12px;
  color: var(--text-2);
}

.v {
  font-size: 13px;
  min-width: 0;
}

/* Times in a row: room for "Gestern, 21:05" so the second one does not move */
.time {
  min-width: 11ch;
}

.amount {
  font-size: 13px;
  color: var(--text-2);
  font-variant-numeric: tabular-nums;
}

.grow {
  flex: 1;
}

.err-text {
  font-size: 13px;
  color: var(--err);
}

/* Without a picker the field is the way to a folder: the accent border, like a focus */
.call-out {
  border-color: var(--accent);
}

.ext {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
}
</style>
