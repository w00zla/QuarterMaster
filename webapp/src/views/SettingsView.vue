<script setup lang="ts">
// The settings of the singleuser variant (/settings, and the desktop shell's settings window): ONE tile that grows downward, built
// like the companion's settings window (companion/src/SettingsApp.vue): a head (icon, title; on the page only, the window's title bar names it), a body of
// groups (a tile on the base background, the group's title on its top border, label left and control right, a field's label above
// its input) and, in the window only, a foot with "Close". Groups: the game folder (Star Citizen), the game data, the UEX trade data
// and the app. Everything applies at once (no save button). Everything comes from /api/local/*; the decisions (tags, what a field
// commit does) are in settingsLogic.ts. In the window the tile is the window's content (App.vue), on the page a tile of the same width.
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import Icon from "../../../adminapp/src/components/Icon.vue";
import ConfirmDialog, { type ConfirmButton } from "../components/ConfirmDialog.vue";
import Dropdown from "../components/Dropdown.vue";
import ImportDialog from "../components/ImportDialog.vue";
import LangSelect from "../components/LangSelect.vue";
import { ApiError } from "../api";
import { lang, t } from "../i18n";
import { checkData, data, loadSettings, pullUex, refreshData, refreshUex, saveSettings, settings, uex } from "../local";
import { dayTime, megabytes, shortTime } from "../localTime";
import { me, saveProfile } from "../session";
import {
  canFetchNow, dataTag, folderView, gameDirChange, isBusy, KEY_MASK, keyDecision, nextFetch, packTag, uexRefused, uexTag,
  type TagModel,
} from "../settingsLogic";
import { shell } from "../shell";
import { toastError } from "../toasts";
import { announceChange, post, settingsWindow } from "../windows";

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

async function fetchNow() {
  try {
    await pullUex();
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

/** The update dialog belongs to the main window: from the settings window it is asked for there (windows.ts) and brought to the front. */
function openUpdate() {
  if (settingsWindow) {
    post({ type: "open-update" });
    shell.focusMain();
  } else shell.openUpdate();
}

const langChoice = computed(() => me.value?.langOverride ?? "auto");
async function setLang(value: string) {
  try {
    await saveProfile({ langOverride: value === "de" || value === "en" ? value : null });
    announceChange();
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
  <div class="page" :class="{ win: settingsWindow }">
    <div v-if="!s || !folder" class="empty-line">{{ t("common.loading") }}</div>
    <div v-else class="settings" :class="{ win: settingsWindow }">
      <!-- The window's title bar names it (App.vue); the page has no bar of its own -->
      <div v-if="!settingsWindow" class="head">
        <Icon name="settings" :size="18" />
        <span class="title">{{ t("nav.settings") }}</span>
      </div>
      <div class="body">
        <form class="form single flush groups" @submit.prevent="submitKey">
          <!-- Star Citizen: the game folder -->
          <section class="group">
            <div class="group-title">
              {{ t("settings.game") }}
              <span v-if="folder.tag" class="tag" :class="tagClass(folder.tag)">{{ t(folder.tag.text) }}</span>
            </div>
            <div class="field">
              <label for="game-dir">{{ t("folder.title") }}</label>
              <div class="line">
                <input
                  id="game-dir"
                  v-model="dirDraft"
                  class="input"
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
            </div>
            <!-- The message keeps its room: nothing moves when it appears -->
            <div class="msg" :class="{ hidden: !folder.message }" :aria-hidden="!folder.message">
              <span class="err-text">{{ t("folder.message") }}</span>
            </div>
            <div class="line between">
              <span class="label">{{ t("folder.version") }}</span>
              <span class="ver-chip" :class="{ none: !s.gameFolder.gameVersion }">{{ s.gameFolder.gameVersion ?? "–" }}</span>
            </div>
            <div class="line between">
              <span class="label">{{ t("folder.pack") }}</span>
              <span class="with pack">
                <!-- The loaded pack's file below the game folder -->
                <span v-if="s.languagePack.file" class="v path" :title="s.languagePack.file">{{ s.languagePack.file }}</span>
                <span class="tag" :class="tagClass(packTag(s.languagePack))">{{ t(packTag(s.languagePack).text) }}</span>
              </span>
            </div>
          </section>

          <!-- Game data -->
          <section class="group">
            <div class="group-title">
              {{ t("data.title") }}
              <span v-if="dataTag(data)" class="tag" :class="tagClass(dataTag(data)!)">{{ t(dataTag(data)!.text) }}</span>
            </div>
            <div class="line between">
              <span class="label">{{ t("data.installed") }}</span>
              <span class="ver-chip" :class="{ none: !data?.installed }">{{ data?.installed?.gameLabel ?? "–" }}</span>
            </div>
            <!-- While busy the amount in place of the check time: one row either way -->
            <div v-if="busy" class="line between">
              <span class="label">{{ t("data.new") }}</span>
              <span class="amount mono">{{ newAmount || "–" }}</span>
            </div>
            <div v-else class="line between">
              <span class="label">{{ t("data.checked") }}</span>
              <span class="v">{{ dayTime(data?.last?.at, new Date(), lang) || "–" }}</span>
            </div>
            <div class="line end">
              <button class="btn outline" type="button" :disabled="busy" @click="importing = true">
                <Icon name="imports" :size="14" /> {{ t("data.import") }}
              </button>
              <button class="btn outline" type="button" :disabled="busy" @click="check">
                <Icon name="search" :size="14" /> {{ t("data.check") }}
              </button>
            </div>
          </section>

          <!-- UEX -->
          <section class="group">
            <div class="group-title">
              {{ t("uex.title") }}
              <span class="tag" :class="tagClass(uexTag(s, uex))">{{ t(uexTag(s, uex).text) }}</span>
            </div>
            <div class="field">
              <!-- Where the key comes from, right above its field -->
              <div class="line between">
                <label for="uex-key">{{ t("uex.key") }}</label>
                <a href="https://uexcorp.space" target="_blank" rel="noopener noreferrer" class="ext"><Icon name="external" :size="14" /> uexcorp.space</a>
              </div>
              <div class="line">
                <input
                  id="uex-key"
                  v-model="keyDraft"
                  class="input"
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
            </div>
            <div class="msg" :class="{ hidden: !refused }" :aria-hidden="!refused">
              <span class="err-text">{{ t("uex.rejected") }}</span>
            </div>
            <div class="line between">
              <span class="label">{{ t("uex.every") }}</span>
              <span class="with">
                <Dropdown :model-value="String(s.uexIntervalMinutes)" variant="outline" :options="intervals" :disabled="!s.uexKeySet" :title="t('uex.every')" @update:model-value="setIntervalMinutes" />
                <button class="btn outline" type="button" :disabled="!canFetchNow(s, uex)" @click="fetchNow">
                  <Icon name="refresh" :size="14" /> {{ t("uex.fetch") }}
                </button>
              </span>
            </div>
            <div class="line between">
              <span class="label">{{ t("uex.lastNext") }}</span>
              <span class="times">
                <span class="v time">{{ shortTime(uex?.lastPull, new Date(), lang) || "–" }}</span>
                <span class="slash">/</span>
                <span class="v time">{{ shortTime(nextFetch(uex), new Date(), lang) || "–" }}</span>
              </span>
            </div>
          </section>

          <!-- App -->
          <section class="group">
            <div class="group-title">{{ t("app.title") }}</div>
            <div class="line between">
              <span class="label">{{ t("app.version") }}</span>
              <span class="with">
                <span class="ver-chip">v{{ s.appVersion }}</span>
                <!-- Only where the desktop shell offers app updates -->
                <button v-if="shell.updateAvailable" class="btn outline" type="button" @click="openUpdate">
                  <Icon name="imports" :size="14" /> {{ t("app.checkUpdate") }}
                </button>
              </span>
            </div>
            <label class="line between">
              <span class="label">{{ t("app.autoUpdate") }}</span>
              <input class="switch" type="checkbox" role="switch" :checked="s.autoUpdate" :disabled="s.overridden.autoUpdate" @change="setAuto" />
            </label>
            <div class="line between">
              <span class="label">{{ t("lang.title") }}</span>
              <LangSelect :model-value="langChoice" variant="outline" up @update:model-value="setLang" />
            </div>
          </section>
        </form>
      </div>
      <!-- Everything applies at once: in the window the foot only closes it; on the page there is none -->
      <div v-if="settingsWindow" class="foot">
        <button type="button" class="btn outline" @click="shell.close()">{{ t("common.close") }}</button>
      </div>
    </div>

    <ImportDialog v-if="importing" @close="importing = false" />
    <ConfirmDialog v-if="removing" :title="t('uex.removeTitle')" icon="lock" :buttons="removeButtons" @choose="removeChoice" />
  </div>
</template>

<style scoped>
/* The tile, as the companion's settings window has it (its head, body and foot as ConfirmDialog.vue's): 560 px wide; in the window it
   is the window's content, on the page a tile of that width with the panels' corners */
.settings {
  width: 560px;
  max-width: 100%;
  background: var(--bg-surface);
  border-radius: var(--radius-panel);
}

.settings.win {
  width: auto;
  max-width: none;
  border-radius: 0;
}

.head,
.foot {
  display: flex;
  align-items: center;
  padding: 16px 20px;
}

.head {
  flex-wrap: nowrap;
  gap: 10px;
  border-bottom: 1px solid var(--border-dim);
}

.title {
  font-weight: 600;
  font-size: 18px;
}

.body {
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding: 18px 20px;
}

.foot {
  justify-content: flex-end;
  gap: 8px;
  border-top: 1px solid var(--border-dim);
}

.foot .btn {
  height: var(--h-control);
  font-size: 14px;
}

/* Room for the group titles straddling the tiles' top edges */
.groups {
  gap: 22px;
  padding-top: 8px;
}

/* Each group is a tile with its title on the top edge, like a fieldset legend (as in BindSight); a state tag sits next to the name
   (the title takes no room of its own: a tag appearing moves nothing) */
.group {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 18px 16px 14px;
  background: var(--bg-base);
  border: 1px solid var(--border-dim);
  border-radius: var(--radius-panel);
}

.group-title {
  position: absolute;
  top: 0;
  left: 12px;
  transform: translateY(-50%);
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 0 8px;
  /* The tile's own ground, to break the group's top border under the label */
  background: var(--bg-surface);
  color: var(--text-2);
  font-size: 13px;
  font-weight: 600;
  white-space: nowrap;
}

.line {
  display: flex;
  align-items: center;
  gap: 8px;
}

.line .input {
  flex: 1;
  min-width: 0;
}

/* A setting's name in a row: like a field's label above its control */
.label {
  font-size: 12px;
  font-weight: 400;
  color: var(--text-2);
}

/* A setting on the left, its control pushed to the right edge (as in BindSight) */
.line.between {
  justify-content: space-between;
}

.line.end {
  justify-content: flex-end;
}

.with {
  display: inline-flex;
  align-items: center;
  gap: 8px;
}

/* The message sits in the gap below its field and takes no room of its own (it cancels one of the two gaps around it): nothing
   moves when it appears, and no empty row stays while there is none */
.msg {
  position: relative;
  height: 0;
  margin-top: -12px;
}

.msg .err-text {
  position: absolute;
  top: 0;
  left: 0;
  font-size: 11px;
  line-height: 12px;
  white-space: nowrap;
}

.hidden {
  visibility: hidden;
}

/* Plain information (a time, a path): quieter than what can be changed */
.v {
  font-size: 12px;
  color: var(--text-2);
}

/* The pack's path gives way before the row breaks */
.pack {
  min-width: 0;
}

.path {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: var(--font-mono);
}

/* Times in a row: room for "Gestern, 21:05" so the second one does not move */
.times {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.time {
  min-width: 11ch;
  text-align: right;
}

.slash {
  color: var(--text-2);
}

.amount {
  font-size: 13px;
  color: var(--text-2);
  font-variant-numeric: tabular-nums;
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
  font-weight: 600;
}
</style>
