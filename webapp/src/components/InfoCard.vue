<script lang="ts">
import type { BlueprintInfo, MaterialInfo } from "../../../src/webapp/api-types";
import { api } from "../api";
import { lang } from "../i18n";

// Loaded cards, per language: the same entry again costs nothing
const cache = new Map<string, Promise<BlueprintInfo | MaterialInfo>>();

/** A blueprint's or material's card data (GET /api/info/...), cached per language. */
export function loadInfo(kind: "blueprint" | "material", uuid: string): Promise<BlueprintInfo | MaterialInfo> {
  const key = `${lang.value}:${kind}:${uuid}`;
  let found = cache.get(key);
  if (!found) {
    found = api<BlueprintInfo | MaterialInfo>(`/info/${kind}/${uuid}?lang=${lang.value}`);
    cache.set(key, found);
    found.catch(() => cache.delete(key));
  }
  return found;
}

/** An item's type line: "Helme · Light" (size, grade and class follow it in the card and the tile). */
export const typeLine = (i: { typeLabel: string | null; subTypeLabel: string | null }) => [i.typeLabel, i.subTypeLabel].filter(Boolean).join(" · ");

// The game's head lines that the card and the tile show themselves, both languages: each goes only when the
// card has that value; the maker always (shown nowhere: it only takes room)
const SHOWN_LINES: Array<[RegExp, (i: MaterialInfo) => unknown]> = [
  [/^(Manufacturer|Hersteller):/i, () => true],
  [/^(Item Type|Type|Typ):/i, (i) => i.typeLabel],
  [/^(Size|Größe):/i, (i) => i.size],
  [/^(Grade|Gütegrad|Güte):/i, (i) => i.gradeLetter],
  [/^(Class|Klasse):/i, (i) => i.itemClass],
];

/**
 * The game's text as one piece (no split into values and prose: it is all the game's text), without the head
 * lines the card already shows ("Typ: Kühler", "Größe: S1", "Gütegrad: C", "Klasse: Civilian (Zivil)") and the
 * maker; tidied: spaces at the line ends and doubled ones gone, at most one blank line in a row, none at the
 * start or end.
 */
export function descriptionText(i: MaterialInfo): string | null {
  const shown = SHOWN_LINES.filter(([, value]) => value(i) != null && value(i) !== "").map(([re]) => re);
  return (i.description ?? "").split("\n").map((l) => l.replace(/[ \t]+/g, " ").trim())
    .filter((l) => !shown.some((re) => re.test(l)))
    .join("\n").replace(/\n{3,}/g, "\n\n").trim() || null;
}
</script>

<script setup lang="ts">
// The info card's content: game data for a blueprint or a material, the L thumbnail left of the text.
// Shown by InfoTip (an overlay on hover) and inline as a tile (the Kaufen/Verkaufen view's pick).
import { computed } from "vue";
import type { PriceRange, PriceSummary } from "../../../src/webapp/api-types";
import Icon from "../../../adminapp/src/components/Icon.vue";
import { typeIcon } from "../../../adminapp/src/typeIcons";
import { thumbPath } from "../../../src/thumbs";
import { materials } from "../catalog";
import { auec, priceRange, priceTime, qty } from "../format";
import { t } from "../i18n";
import { blueprintThumb, materialThumb } from "../thumbs";
import { bestText, kindCount, markerClass, markerText } from "../unlocks";

const props = defineProps<{ kind: "blueprint" | "material"; uuid: string; info: BlueprintInfo | MaterialInfo }>();

// The L thumbnail left of the card's text (a blueprint: the item it crafts); none without a hash
const thumb = computed(() => (props.kind === "blueprint" ? blueprintThumb(props.uuid) : materialThumb(props.uuid)));
const thumbSrc = computed(() => (thumb.value.hash ? thumbPath("l", thumb.value.uuid, thumb.value.hash) : null));

const bp = computed(() => (props.kind === "blueprint" ? (props.info as BlueprintInfo) : null));
const mat = computed(() => (props.kind === "material" ? (props.info as MaterialInfo) : null));
const description = computed(() => (mat.value ? descriptionText(mat.value) : null));

// No maker anywhere: it only takes room
const itemLine = (i: { typeLabel: string | null; subTypeLabel: string | null; size: number | null; gradeLetter: string | null; itemClass: string | null }) =>
  [i.typeLabel, i.subTypeLabel, i.size !== null ? `S${i.size}` : null, [i.gradeLetter, i.itemClass].filter(Boolean).join(" ") || null]
    .filter(Boolean).join(" · ");

// The price lines: sell, then buy (a side without a price: range null, shown as "—"); after the range UEX's
// average, else (items) the number of terminals
const priceSides = (p: PriceSummary) => ([[t("trade.sell"), p.sell], [t("trade.buy"), p.buy]] as const)
  .map(([label, range]: readonly [string, PriceRange | null]) => ({
    label, range,
    extra: !range ? "" : range.avg !== null ? `⌀ ${auec(range.avg)}` : t(range.terminals === 1 ? "trade.terminal" : "trade.terminals", { n: range.terminals }),
  }));
</script>

<template>
  <div class="info-card" :class="{ 'with-thumb': thumbSrc }">
    <img v-if="thumbSrc" class="card-thumb" :src="thumbSrc" width="128" height="128" alt="" />
    <div class="card-body">
      <template v-if="bp">
        <div class="title">
          <Icon :name="bp.type ? typeIcon(bp.type) : 'blueprint'" :size="15" />
          <span>{{ bp.name }}</span>
          <span v-if="bp.isDefault" class="tag accent">{{ t("info.default") }}</span>
          <span v-if="bp.retired" class="tag err">{{ t("bp.retired") }}</span>
        </div>
        <div v-if="itemLine(bp)" class="meta">{{ itemLine(bp) }}</div>
        <dl class="kv">
          <template v-if="bp.category"><dt>{{ t("bp.col.category") }}</dt><dd>{{ bp.category }}</dd></template>
          <template v-if="bp.requiredSlots < bp.slots.length"><dt>{{ t("info.slots") }}</dt><dd>{{ t("info.slotsOf", { n: bp.requiredSlots, m: bp.slots.length }) }}</dd></template>
        </dl>
        <div v-if="bp.slots.length" class="section">{{ t("info.ingredients") }}</div>
        <ul v-if="bp.slots.length" class="inputs">
          <li v-for="(s, n) in bp.slots" :key="n">
            <span class="slot">{{ s.name ?? t("info.slot", { n: n + 1 }) }}</span>
            <span>
              <template v-for="(i, k) in s.inputs" :key="k">
                <span v-if="k" class="faint"> / </span>{{ i.name }} <span class="dim">{{ qty(i.quantity, i.kind === "resource" ? "SCU" : "pcs") }}</span><span v-if="i.minQuality" class="dim"> · Q≥{{ i.minQuality }}</span>
              </template>
            </span>
          </li>
        </ul>
        <!-- Freischaltung: eine Zeile je Art, Marker nur wenn alle Quellen sie haben, rechts die beste Chance -->
        <div class="section">{{ t("unlock.title") }}</div>
        <ul v-if="bp.unlocks.length" class="unlocks">
          <li v-for="u in bp.unlocks" :key="u.kind">
            <span>{{ kindCount(u.kind, u.count) }}</span>
            <span v-for="m in u.markers" :key="m" class="tag" :class="markerClass(m)">{{ markerText(m) }}</span>
            <span class="unlock-odds">{{ bestText(u) }}</span>
          </li>
        </ul>
        <div v-else class="dim">{{ t("unlock.none") }}</div>
      </template>

      <template v-else-if="mat">
        <div class="title">
          <Icon :name="mat.kind === 'resource' ? 'resource' : typeIcon(mat.type)" :size="15" />
          <span>{{ mat.name }}</span>
          <span v-if="mat.isOre" class="tag warn">{{ t("info.ore") }}</span>
        </div>
        <div v-if="mat.kind === 'resource' ? mat.group : itemLine(mat)" class="meta dot">{{ mat.kind === "resource" ? mat.group : itemLine(mat) }}</div>
        <!-- Der Spieltext am Stück, nur aufgeräumt (descriptionText) -->
        <p v-if="description" class="description">{{ description }}</p>
        <dl class="kv">
          <template v-if="mat.refined"><dt>{{ t("info.refinedTo") }}</dt><dd>{{ mat.refined }}</dd></template>
          <template v-if="mat.ores.length"><dt>{{ t("info.fromOre") }}</dt><dd>{{ mat.ores.join(", ") }}</dd></template>
          <!-- Ausrüstung ist nie Zutat eines Bauplans: keine Zeile dafür -->
          <template v-if="!materials.get(uuid)?.component"><dt>{{ t("info.usedIn") }}</dt><dd>{{ t("info.blueprints", { n: mat.usedIn }) }}</dd></template>
        </dl>
        <!-- Bauplan (Items immer, sonst "Kein Bauplan"): je Bauplan Standard, dann die Freischaltung wie auf der
             Bauplan-Karte; sein Name nur, wenn er vom Item abweicht oder es mehrere gibt -->
        <template v-if="mat.kind === 'item'">
          <div class="section">{{ t("info.craftedBy") }}</div>
          <div v-if="!mat.craftedBy.length" class="dim">{{ t("info.noBlueprint") }}</div>
          <div v-for="b in mat.craftedBy" :key="b.uuid" class="crafted">
            <div v-if="mat.craftedBy.length > 1 || b.name !== mat.name || b.isDefault" class="crafted-line">
              <span v-if="mat.craftedBy.length > 1 || b.name !== mat.name" class="crafted-name">{{ b.name }}</span>
              <span v-if="b.isDefault" class="tag accent">{{ t("info.default") }}</span>
            </div>
            <ul v-if="b.unlocks.length" class="unlocks">
              <li v-for="u in b.unlocks" :key="u.kind">
                <span>{{ kindCount(u.kind, u.count) }}</span>
                <span v-for="m in u.markers" :key="m" class="tag" :class="markerClass(m)">{{ markerText(m) }}</span>
                <span class="unlock-odds">{{ bestText(u) }}</span>
              </li>
            </ul>
            <div v-else-if="!b.isDefault" class="dim">{{ t("unlock.none") }}</div>
          </div>
        </template>
        <!-- UEX-Preise (immer): Spanne über die Terminals, dahinter der UEX-Durchschnitt (Gegenstände: die Zahl der
             Terminals); eine Seite ohne Preis "—", ganz ohne "Keine Preise" -->
        <div class="section price-head"><span>{{ t("trade.prices") }}</span><span v-if="mat.prices" class="source">UEX · {{ priceTime(mat.prices.date) }}</span></div>
        <dl v-if="mat.prices" class="kv">
          <template v-for="s in priceSides(mat.prices)" :key="s.label">
            <dt>{{ s.label }}</dt>
            <dd v-if="s.range">{{ priceRange(s.range) }}&nbsp;aUEC <span class="dim">· {{ s.extra }}</span></dd>
            <dd v-else class="dim">—</dd>
          </template>
        </dl>
        <div v-else class="dim">{{ t("info.noPrices") }}</div>
      </template>
    </div>
  </div>
</template>

<style scoped>
.info-card {
  display: flex;
  gap: 14px;
  font-size: 12px;
  color: var(--text-2);
}

.card-thumb {
  flex-shrink: 0;
  width: 128px;
  height: 128px;
  object-fit: contain;
}

.card-body {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 0;
}

/* Narrow screens: the thumbnail above the text */
@media (max-width: 560px) {
  .info-card.with-thumb {
    flex-direction: column;
  }
}

.title {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 14px;
  font-weight: 600;
  color: var(--text);
}

.meta {
  color: var(--text-2);
}

/* The meta line after a bullet */
.dot::before {
  content: "•";
  margin-right: 7px;
  color: var(--text-3);
}


/* The game's text, quiet, keeps its line breaks; long ones are cut after a few lines */
.description {
  margin: 0;
  white-space: pre-line;
  line-height: 1.45;
  color: var(--text-3);
  display: -webkit-box;
  -webkit-line-clamp: 8;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.kv {
  display: grid;
  grid-template-columns: max-content minmax(0, 1fr);
  gap: 3px 12px;
  margin: 0;
}

.kv dt {
  color: var(--text-3);
}

.kv dd {
  margin: 0;
  color: var(--text);
}

/* A category's head (Zutaten, Freischaltung, Preise): set apart from what comes before */
.section {
  margin-top: 8px;
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: var(--text-3);
}

/* "Preise" left, the source and its date right */
.price-head {
  display: flex;
  justify-content: space-between;
  gap: 12px;
}

.price-head .source {
  letter-spacing: normal;
  text-transform: none;
  font-weight: 500;
}

.inputs {
  margin: 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 3px;
  color: var(--text);
}

.inputs li {
  display: grid;
  grid-template-columns: 90px minmax(0, 1fr);
  gap: 10px;
}

.slot {
  color: var(--text-3);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* A blueprint that crafts the item: its line (name where needed, Standard), its unlocks below */
.crafted {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.crafted-line {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}

.crafted-name {
  color: var(--text);
}

/* One line per kind: count, markers, the best chance at the right */
.unlocks {
  margin: 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 4px;
  color: var(--text);
}

.unlocks li {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
}

.unlock-odds {
  margin-left: auto;
  padding-left: 6px;
  white-space: nowrap;
}
</style>
