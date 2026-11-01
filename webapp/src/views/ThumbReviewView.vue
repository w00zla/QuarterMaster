<script setup lang="ts">
// Thumbnail-Prüfung (privilege thumb-review, docs/webapp.md "Privileges"): every item thumbnail in a grid per
// type. A click on a thumbnail marks it as wrong (the own row of app.feature_entry, payload = the thumbnail's
// hash), the camera takes a reference: a frame of a screen, window or tab picked once (getDisplayMedia, the
// stream stays open), cut to a region with the mouse. Everyone with the privilege sees every mark.
import { computed, onUnmounted, ref } from "vue";
import type {
  FeatureEntriesResponse, FeatureEntry, ThumbReviewSubject, ThumbReviewSubjectsResponse,
} from "../../../src/webapp/api-types";
import Icon from "../../../adminapp/src/components/Icon.vue";
import { thumbPath } from "../../../src/thumbs";
import { api } from "../api";
import ConfirmDialog from "../components/ConfirmDialog.vue";
import { lang, t } from "../i18n";
import { coalesced, onServerMessage } from "../realtime";
import { me } from "../session";
import { toast, toastError } from "../toasts";

const KEY = "thumb-review";
// The server's limit for one image (src/webapp/features.ts)
const MAX_IMAGE_BYTES = 512 * 1024;

const allowed = computed(() => me.value?.privileges.includes(KEY) ?? false);

// The explanation panel folds; remembered per browser
const INTRO_KEY = "qm.review.introOpen";
const introOpen = ref(true);
try {
  introOpen.value = localStorage.getItem(INTRO_KEY) !== "0";
} catch {
  // Not readable: open
}
function toggleIntro() {
  introOpen.value = !introOpen.value;
  try {
    localStorage.setItem(INTRO_KEY, introOpen.value ? "1" : "0");
  } catch {
    // Not remembered
  }
}
const subjects = ref<ThumbReviewSubject[] | null>(null);
const entries = ref<FeatureEntry[]>([]);
const search = ref("");
const onlyMarked = ref(false);

async function loadSubjects() {
  try {
    subjects.value = (await api<ThumbReviewSubjectsResponse>(`/features/${KEY}/subjects?lang=${lang.value}`)).subjects;
  } catch (e) {
    toastError(e);
  }
}
async function loadEntries() {
  try {
    entries.value = (await api<FeatureEntriesResponse>(`/features/${KEY}/entries`)).entries;
  } catch (e) {
    toastError(e);
  }
}
if (allowed.value) {
  void loadSubjects();
  void loadEntries();
}
// The other reviewers' marks live
const reload = coalesced(() => void loadEntries());
const unsubscribe = onServerMessage((m) => {
  if (m.type === "feature" && m.key === KEY) reload.schedule();
});

// Marks per thumbnail: the own one apart
const bySubject = computed(() => {
  const map = new Map<string, { own: FeatureEntry | null; others: FeatureEntry[] }>();
  for (const e of entries.value) {
    const slot = map.get(e.subject) ?? { own: null, others: [] };
    if (e.own) slot.own = e;
    else slot.others.push(e);
    map.set(e.subject, slot);
  }
  return map;
});

// Groups by item class (resources apart), names inside; the search over name and class name
const groups = computed(() => {
  const q = search.value.trim().toLowerCase();
  const out = new Map<string, ThumbReviewSubject[]>();
  for (const s of subjects.value ?? []) {
    if (onlyMarked.value && !bySubject.value.has(s.uuid)) continue;
    if (q && !s.name.toLowerCase().includes(q) && !s.className.toLowerCase().includes(q)) continue;
    const label = s.type === null ? t("review.resources") : [s.typeLabel ?? s.type, s.subType && s.subType !== "UNDEFINED" ? s.subType : null].filter(Boolean).join(" · ");
    out.set(label, [...(out.get(label) ?? []), s]);
  }
  return [...out].sort(([a], [b]) => a.localeCompare(b, lang.value))
    .map(([label, list]) => ({ label, list: list.sort((a, b) => a.name.localeCompare(b.name, lang.value)) }));
});

const blobUrl = (e: FeatureEntry) => `/api/features/${KEY}/blob/${e.id}?v=${encodeURIComponent(e.updatedAt)}`;
// The reference shown on the tile: the own one, else the newest of the others
const shownRef = (s: ThumbReviewSubject) => {
  const slot = bySubject.value.get(s.uuid);
  return [slot?.own, ...(slot?.others ?? [])].find((e) => e?.blobType) ?? null;
};
const markers = (s: ThumbReviewSubject) => {
  const slot = bySubject.value.get(s.uuid);
  return slot ? [slot.own, ...slot.others].filter((e): e is FeatureEntry => e !== null) : [];
};
const tileTitle = (s: ThumbReviewSubject) => {
  const names = markers(s).map((e) => e.userName ?? e.userId);
  return [s.name, s.className, names.length ? t("review.markedBy", { names: names.join(", ") }) : null].filter(Boolean).join("\n");
};
// Marked on another thumbnail than the current one: re-rendered since
const rerendered = (s: ThumbReviewSubject) => markers(s).some((e) => e.payload.hash !== s.hash);

const busy = ref(false);
const removing = ref<ThumbReviewSubject | null>(null);

async function toggle(s: ThumbReviewSubject) {
  const own = bySubject.value.get(s.uuid)?.own;
  if (own?.blobType) {
    removing.value = s;
    return;
  }
  await write(own ? () => api(`/features/${KEY}/entries/${s.uuid}`, { method: "DELETE", body: {} })
    : () => api(`/features/${KEY}/entries/${s.uuid}`, { method: "PUT", body: { payload: { hash: s.hash } } }));
}

async function write(action: () => Promise<unknown>) {
  busy.value = true;
  try {
    await action();
    await loadEntries();
  } catch (e) {
    toastError(e);
  } finally {
    busy.value = false;
  }
}

function confirmRemove(value: string) {
  const s = removing.value;
  removing.value = null;
  if (value === "remove" && s) void write(() => api(`/features/${KEY}/entries/${s.uuid}`, { method: "DELETE", body: {} }));
}

// --- capture: a screen, window or tab, picked once; each reference takes the stream's current frame ---
const stream = ref<MediaStream | null>(null);
const video = document.createElement("video");
video.muted = true;
video.playsInline = true;

async function pickSource(): Promise<boolean> {
  stream.value?.getTracks().forEach((track) => track.stop());
  stream.value = null;
  try {
    const s = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 10 }, audio: false });
    s.getVideoTracks()[0]?.addEventListener("ended", () => (stream.value = null));
    video.srcObject = s;
    await video.play();
    if (!video.videoWidth) await new Promise((r) => video.addEventListener("loadeddata", r, { once: true }));
    stream.value = s;
    return true;
  } catch {
    return false;
  }
}

onUnmounted(() => {
  unsubscribe();
  reload.cancel();
  stream.value?.getTracks().forEach((track) => track.stop());
});

// --- region: the frame in full resolution, a rectangle drawn with the mouse; none = the whole frame ---
const cropping = ref<ThumbReviewSubject | null>(null);
const canvas = ref<HTMLCanvasElement | null>(null);
let frame: HTMLCanvasElement | null = null;
let selection: { x: number; y: number; w: number; h: number } | null = null;
let dragFrom: { x: number; y: number } | null = null;

async function capture(s: ThumbReviewSubject) {
  if (!stream.value && !(await pickSource())) return;
  frame = document.createElement("canvas");
  frame.width = video.videoWidth;
  frame.height = video.videoHeight;
  frame.getContext("2d")!.drawImage(video, 0, 0);
  selection = null;
  cropping.value = s;
  // The canvas exists after the next render
  requestAnimationFrame(draw);
}

function draw() {
  const c = canvas.value;
  if (!c || !frame) return;
  c.width = frame.width;
  c.height = frame.height;
  const ctx = c.getContext("2d")!;
  ctx.drawImage(frame, 0, 0);
  const sel = selection;
  if (!sel || sel.w < 2 || sel.h < 2) return;
  ctx.fillStyle = "rgba(0, 0, 0, 0.6)";
  ctx.fillRect(0, 0, c.width, sel.y);
  ctx.fillRect(0, sel.y + sel.h, c.width, c.height - sel.y - sel.h);
  ctx.fillRect(0, sel.y, sel.x, sel.h);
  ctx.fillRect(sel.x + sel.w, sel.y, c.width - sel.x - sel.w, sel.h);
  ctx.strokeStyle = "#54adf7";
  ctx.lineWidth = Math.max(2, c.width / 800);
  ctx.strokeRect(sel.x, sel.y, sel.w, sel.h);
}

// The mouse in frame pixels (the canvas is scaled down to the page)
function framePoint(ev: PointerEvent) {
  const c = canvas.value!;
  const r = c.getBoundingClientRect();
  return {
    x: Math.min(Math.max(ev.clientX - r.left, 0), r.width) * (c.width / r.width),
    y: Math.min(Math.max(ev.clientY - r.top, 0), r.height) * (c.height / r.height),
  };
}
function onDown(ev: PointerEvent) {
  dragFrom = framePoint(ev);
  canvas.value?.setPointerCapture(ev.pointerId);
}
function onMove(ev: PointerEvent) {
  if (!dragFrom) return;
  const p = framePoint(ev);
  selection = { x: Math.min(dragFrom.x, p.x), y: Math.min(dragFrom.y, p.y), w: Math.abs(p.x - dragFrom.x), h: Math.abs(p.y - dragFrom.y) };
  draw();
}

// WebP, scaled down until it fits the server's limit (a whole 4K frame would not)
async function encode(source: HTMLCanvasElement): Promise<Blob> {
  for (let scale = 1; ; scale *= 0.75) {
    const out = document.createElement("canvas");
    out.width = Math.max(1, Math.round(source.width * scale));
    out.height = Math.max(1, Math.round(source.height * scale));
    out.getContext("2d")!.drawImage(source, 0, 0, out.width, out.height);
    const blob = await new Promise<Blob | null>((r) => out.toBlob(r, "image/webp", 0.9));
    if (!blob) throw new Error("encode");
    if (blob.size <= MAX_IMAGE_BYTES || out.width < 64) return blob;
  }
}

async function saveCrop(value: string) {
  const s = cropping.value;
  if (value !== "save" || !s || !frame) {
    cropping.value = null;
    frame = null;
    return;
  }
  const sel = selection && selection.w >= 4 && selection.h >= 4 ? selection : { x: 0, y: 0, w: frame.width, h: frame.height };
  const cut = document.createElement("canvas");
  cut.width = Math.round(sel.w);
  cut.height = Math.round(sel.h);
  cut.getContext("2d")!.drawImage(frame, Math.round(sel.x), Math.round(sel.y), cut.width, cut.height, 0, 0, cut.width, cut.height);
  cropping.value = null;
  frame = null;
  await write(async () => {
    const blob = await encode(cut);
    const data = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ""));
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(blob);
    });
    // The mark first: the image belongs to the own row
    if (!bySubject.value.get(s.uuid)?.own) await api(`/features/${KEY}/entries/${s.uuid}`, { method: "PUT", body: { payload: { hash: s.hash } } });
    await api(`/features/${KEY}/entries/${s.uuid}/blob`, { method: "PUT", body: { type: blob.type === "image/png" ? "image/png" : "image/webp", data } });
    toast(t("review.saved"));
  });
}
</script>

<template>
  <div class="page">
    <section v-if="allowed" class="panel intro">
      <div class="head intro-head" @click="toggleIntro">
        <Icon name="info" :size="16" />
        <span class="head-title no-grow">{{ t("review.introTitle") }}</span>
        <div class="spacer" />
        <button type="button" class="icon-btn" :title="t(introOpen ? 'review.introHide' : 'review.introShow')" @click.stop="toggleIntro">
          <Icon :name="introOpen ? 'chevron-up' : 'chevron-down'" :size="16" />
        </button>
      </div>
      <div v-if="introOpen" class="intro-body">
        <p>{{ t("review.introWhat") }}</p>
        <p>{{ t("review.introHow") }}</p>
        <p>{{ t("review.introYellow") }}</p>
      </div>
    </section>

    <section class="panel unclipped">
      <div class="head">
        <Icon name="eye" :size="16" />
        <span class="head-title no-grow">{{ t("nav.thumbReview") }}</span>
        <div class="divider" />
        <label class="search">
          <Icon name="search" :size="14" />
          <input v-model="search" :placeholder="t('review.search')" />
          <button v-if="search" type="button" class="clear" :title="t('common.clear')" @click="search = ''"><Icon name="close" :size="12" /></button>
        </label>
        <button type="button" class="chip" :class="{ active: onlyMarked }" @click="onlyMarked = !onlyMarked">
          <Icon name="filter" :size="13" /> {{ t("review.onlyMarked") }}
        </button>
        <div class="spacer" />
        <span class="tag" :class="stream ? 'ok' : 'err'">
          <span class="swap"><span :class="{ hidden: stream }">{{ t("review.sourceOff") }}</span><span :class="{ hidden: !stream }">{{ t("review.sourceOn") }}</span></span>
        </span>
        <button type="button" class="btn small outline" @click="pickSource"><Icon name="desktop" :size="14" /> {{ t("review.source") }}</button>
      </div>

      <div v-if="!allowed" class="empty-line">{{ t("review.noPrivilege") }}</div>
      <div v-else-if="!subjects" class="empty-line">{{ t("common.loading") }}</div>
      <div v-else-if="!groups.length" class="empty-line">{{ t("common.noMatch") }}</div>
      <div v-else class="groups">
        <section v-for="g in groups" :key="g.label" class="group">
          <div class="group-head">{{ g.label }}</div>
          <div class="grid">
            <div
              v-for="s in g.list" :key="s.uuid" class="tile"
              :class="{ own: bySubject.get(s.uuid)?.own, other: !bySubject.get(s.uuid)?.own && bySubject.has(s.uuid) }"
              :title="tileTitle(s)"
            >
              <button type="button" class="pic-btn" :disabled="busy" @click="toggle(s)">
                <img class="pic" :src="thumbPath('l', s.uuid, s.hash)" loading="lazy" decoding="async" alt="" />
              </button>
              <button v-if="bySubject.get(s.uuid)?.own" type="button" class="cam" :title="t('review.capture')" :disabled="busy" @click="capture(s)">
                <Icon name="camera" :size="15" />
              </button>
              <a v-if="shownRef(s)" class="ref" :href="blobUrl(shownRef(s)!)" target="_blank" rel="noopener"><img :src="blobUrl(shownRef(s)!)" alt="" /></a>
              <span v-if="markers(s).length > 1" class="tag count">{{ markers(s).length }}</span>
              <span class="name">{{ s.name }}</span>
              <span class="cls">{{ s.className }}</span>
              <span v-if="rerendered(s)" class="tag accent rerendered">{{ t("review.rerendered") }}</span>
            </div>
          </div>
        </section>
      </div>
    </section>

    <ConfirmDialog
      v-if="removing"
      icon="trash"
      :title="t('review.removeTitle')"
      :subtitle="removing.name"
      :buttons="[{ label: t('common.cancel'), kind: 'outline', value: 'cancel' }, { label: t('review.remove'), kind: 'danger', value: 'remove', icon: 'trash' }]"
      @choose="confirmRemove"
    >
      {{ t("review.removeText") }}
    </ConfirmDialog>

    <ConfirmDialog
      v-if="cropping"
      icon="camera"
      :title="t('review.cropTitle')"
      :subtitle="cropping.name"
      xxl
      :buttons="[{ label: t('common.cancel'), kind: 'outline', value: 'cancel' }, { label: t('common.save'), kind: 'primary', value: 'save', icon: 'check' }]"
      @choose="saveCrop"
    >
      <canvas ref="canvas" class="crop" @pointerdown="onDown" @pointermove="onMove" @pointerup="dragFrom = null" />
    </ConfirmDialog>
  </div>
</template>

<style scoped>
/* The whole title row folds the explanation, the chevron too */
.intro-head {
  cursor: pointer;
  user-select: none;
}

.intro-body {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px 16px 16px;
  max-width: 90ch;
  font-size: 13px;
  line-height: 1.5;
  color: var(--text-2);
}

.intro-body p {
  margin: 0;
}

.groups {
  display: flex;
  flex-direction: column;
  gap: 20px;
  padding: 16px;
}

.group-head {
  margin-bottom: 10px;
  font-size: 13px;
  font-weight: 600;
  color: var(--text-2);
}

.grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, 150px);
  gap: 10px;
}

/* Marks, camera and reference sit on top: the tile keeps its size in every state */
.tile {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 8px;
  border: 1px solid var(--border-dim);
  border-radius: var(--radius-panel);
  background: var(--bg-surface);
}

.tile.own {
  border-color: var(--err);
  background: color-mix(in srgb, var(--err) 8%, var(--bg-surface));
}

.tile.other {
  border-color: var(--warn);
}

.pic-btn {
  padding: 0;
  border: none;
  background: transparent;
  cursor: pointer;
}

.pic {
  display: block;
  width: 132px;
  height: 132px;
  object-fit: contain;
}

.cam {
  position: absolute;
  top: 6px;
  right: 6px;
  width: 28px;
  height: 28px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 1px solid rgba(255, 255, 255, 0.5);
  border-radius: var(--radius-control);
  background: var(--bg-base);
  color: var(--text);
  cursor: pointer;
}

.ref {
  position: absolute;
  left: 6px;
  top: 86px;
  width: 52px;
  height: 52px;
}

.ref img {
  width: 100%;
  height: 100%;
  object-fit: contain;
  border: 1px solid var(--warn);
  border-radius: var(--radius-control);
  background: #000;
}

.count {
  position: absolute;
  top: 8px;
  left: 8px;
}

.rerendered {
  position: absolute;
  top: 116px;
  right: 8px;
}

.name {
  font-size: 12px;
  font-weight: 600;
  line-height: 15px;
  height: 30px;
  overflow: hidden;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
}

.cls {
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--text-3);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.crop {
  display: block;
  max-width: 100%;
  max-height: 70vh;
  margin: 0 auto;
  cursor: crosshair;
  touch-action: none;
}
</style>
