// The signature scan in the main window (Rust: ocrwatch.rs, mining.rs; event "signature-read"): its switch (the
// Bergbau panel's chip, the scan mode hotkey; kept across starts), the latest signatures the scan saw (a new one
// when the number changes: the plate shows the same for a while) and the resources each can stand for
// (signatures.ts over the catalog's rock kinds, in the UI language), each with its mining method's icon. The
// signature overlay (SignatureApp.vue) gets the newest one's resources as its view ("signature-view") on every change
// and when it asks. The scan switches itself to the signature alone while it is on (scan.ts). The last reads are
// kept for the debug window (`signatureReads`).
import { emit, listen } from "@tauri-apps/api/event";
import { computed, ref, shallowRef, watch } from "vue";
import type { IconName } from "../../adminapp/src/components/Icon.vue";
import type { CompanionCatalogRock } from "../../src/webapp/api-types.ts";
import type { SignatureEvent, SignaturePosition } from "./backend";
import { detected } from "./detections";
import { langRef, t } from "./i18n";
import { catalogResponses } from "./refinerySync";
import { matchSignature, matchText, type SignatureMatch } from "./signatures";
import { config } from "./state";

const KEY = "qm.companion.mining.signature";
export const signatureOn = ref(localStorage.getItem(KEY) === "1");

export function toggleSignature() {
  signatureOn.value = !signatureOn.value;
  localStorage.setItem(KEY, signatureOn.value ? "1" : "0");
}

export interface SignatureEntry {
  // When the scan first saw it
  atMs: number;
  value: number;
}

// The latest signatures, newest first
export const history = ref<SignatureEntry[]>([]);
const KEEP = 50;

export function clearHistory() {
  history.value = [];
}

// The last reads as they came (the debug window), newest first
export const signatureReads = shallowRef<SignatureEvent[]>([]);
const KEEP_READS = 20;

// The catalog's rock kinds in the UI language (an older server sends none)
const rocks = computed(() => catalogResponses.value?.[langRef.value]?.rocks ?? []);

export const METHOD_ICONS: Record<CompanionCatalogRock["method"], IconName> = { ship: "mine-ship", roc: "mine-roc", fps: "mine-hand" };

/** The rock kinds a signature can stand for, fewest nodes first; empty when none fits. */
export const matchesOf = (value: number): SignatureMatch[] => matchSignature(value, rocks.value);

/** What to say when no resource fits: none fits, or the catalog has no rock signatures to compare with. */
export const noMatchText = () => t(rocks.value.length ? "mining.noMatch" : "mining.noData");

/** A line of the signature overlay: the resource with its count, the mining method's icon (none: the line saying
 * that nothing fits). */
export interface SignatureLine {
  text: string;
  icon: IconName | null;
}

/** What the signature overlay shows: the newest signature's resources, where it sits next to the number (the tile
 * aligns to that side) and how see-through it is. */
export interface SignatureView {
  lines: SignatureLine[];
  none: boolean;
  position: SignaturePosition;
  transparency: number;
}

const view = computed<SignatureView>(() => {
  const newest = history.value[0];
  const matches = newest ? matchesOf(newest.value) : [];
  return {
    lines: matches.length ? matches.map((m) => ({ text: matchText(m), icon: METHOD_ICONS[m.method] })) : [{ text: noMatchText(), icon: null }],
    none: !matches.length,
    position: config.value?.signaturePosition ?? "below",
    transparency: config.value?.overlayTransparency ?? 18,
  };
});

const publish = () => void emit("signature-view", view.value).catch(() => undefined);

/** What the debug window shows of the signature scan (it has no catalog): the last reads with the resources each
 * can stand for, how many rock kinds with a signature the catalog has, the overlay's settings. */
export interface SignatureReport {
  rocks: number;
  position: SignaturePosition;
  transparency: number;
  reads: Array<{ atMs: number; value: number | null; raw: string; score: number; matches: SignatureLine[] }>;
}

const report = computed<SignatureReport>(() => ({
  rocks: rocks.value.length,
  position: view.value.position,
  transparency: view.value.transparency,
  reads: signatureReads.value.map((e) => ({
    atMs: e.atMs, value: e.read.value, raw: e.read.raw, score: e.read.score,
    matches: e.read.value === null ? [] : matchesOf(e.read.value).map((m) => ({ text: matchText(m), icon: METHOD_ICONS[m.method] })),
  })),
}));

const publishReport = () => void emit("signature-report", report.value).catch(() => undefined);

export async function watchMining() {
  watch(report, publishReport);
  await listen("signature-report-request", publishReport);
  await listen<SignatureEvent>("signature-read", (e) => {
    signatureReads.value = [e.payload, ...signatureReads.value].slice(0, KEEP_READS);
    const value = e.payload.read.value;
    if (value === null || history.value[0]?.value === value) return;
    history.value = [{ atMs: e.payload.atMs, value }, ...history.value].slice(0, KEEP);
    detected();
  });
  watch(view, publish);
  await listen("signature-request", publish);
}
