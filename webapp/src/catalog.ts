// Game texts for the pickers (GET /api/catalog), in the effective language. Cached per language;
// reloaded when the language changes and on 'resync'.
import { computed, ref, watch } from "vue";
import type { CatalogBlueprint, CatalogLocation, CatalogMaterial, CatalogResponse, Lang } from "../../src/webapp/api-types";
import { api } from "./api";
import { lang } from "./i18n";
import { onServerMessage } from "./realtime";
import { status } from "./session";

const cache = new Map<Lang, CatalogResponse>();
export const catalog = ref<CatalogResponse | null>(null);
export const catalogFailed = ref(false);

let seq = 0;
async function load(l: Lang, force = false) {
  const cached = cache.get(l);
  if (cached && !force) {
    catalog.value = cached;
    return;
  }
  const mine = ++seq;
  try {
    const data = await api<CatalogResponse>(`/catalog?lang=${l}`);
    cache.set(l, data);
    // A newer request (language switched meanwhile) wins
    if (mine === seq) catalog.value = data;
    catalogFailed.value = false;
  } catch {
    if (mine === seq) catalogFailed.value = true;
  }
}

watch([lang, status], ([l, s]) => {
  if (s === "in") void load(l);
}, { immediate: true });

onServerMessage((m) => {
  if (m.type !== "resync") return;
  cache.clear();
  if (status.value === "in") void load(lang.value, true);
});

const byUuid = <T extends { uuid: string }>(list: T[] | undefined) => new Map((list ?? []).map((x) => [x.uuid, x]));

export const materials = computed(() => byUuid<CatalogMaterial>(catalog.value?.materials));
export const locations = computed(() => byUuid<CatalogLocation>(catalog.value?.locations));
export const blueprints = computed(() => byUuid<CatalogBlueprint>(catalog.value?.blueprints));

const byName = (a: string, b: string) => a.localeCompare(b, lang.value);

// Picker options, alphabetical
export const materialOptions = computed(() => (catalog.value?.materials ?? []).filter((m) => !m.isOre)
  .map((m) => ({ value: m.uuid, label: m.name })).sort((a, b) => byName(a.label, b.label)));
export const oreOptions = computed(() => (catalog.value?.materials ?? []).filter((m) => m.isOre)
  .map((m) => ({ value: m.uuid, label: m.name })).sort((a, b) => byName(a.label, b.label)));
export const locationOptions = computed(() => (catalog.value?.locations ?? [])
  .map((l) => ({ value: l.uuid, label: l.label })).sort((a, b) => byName(a.label, b.label)));
export const refineryLocationOptions = computed(() => (catalog.value?.locations ?? []).filter((l) => l.refinery)
  .map((l) => ({ value: l.uuid, label: l.label })).sort((a, b) => byName(a.label, b.label)));
