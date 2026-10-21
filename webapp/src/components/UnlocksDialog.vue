<script setup lang="ts">
// Where a blueprint comes from (GET /api/unlocks): one section per kind. Missions grouped by faction and
// mission type (collapsed, a single group open), every row listed (the list scrolls inside, its head
// row stays); event tiers with their points.
import { onMounted, ref } from "vue";
import type { UnlockMissionGroup, UnlockMissionRow, UnlocksResponse } from "../../../src/webapp/api-types";
import Icon from "../../../adminapp/src/components/Icon.vue";
import { api } from "../api";
import { lang, t } from "../i18n";
import { toastError } from "../toasts";
import { bestText, kindCount, markerClass, markerText, oddsText, pointsText } from "../unlocks";
import ConfirmDialog, { type ConfirmButton } from "./ConfirmDialog.vue";

const props = defineProps<{ uuid: string; name: string }>();
const emit = defineEmits<{ close: [] }>();

const buttons: ConfirmButton[] = [{ label: t("common.close"), kind: "outline", value: "close" }];
const data = ref<UnlocksResponse | null>(null);
// Open mission groups (by index)
const open = ref(new Set<number>());

onMounted(async () => {
  try {
    data.value = await api<UnlocksResponse>(`/unlocks/${props.uuid}?lang=${lang.value}`);
    const missions = data.value.sections.find((s) => s.kind === "mission");
    if (missions?.kind === "mission" && missions.groups.length === 1) open.value = new Set([0]);
  } catch (e) {
    toastError(e);
    emit("close");
  }
});

function toggle(i: number) {
  const next = new Set(open.value);
  if (next.has(i)) next.delete(i);
  else next.add(i);
  open.value = next;
}

const groupName = (g: UnlockMissionGroup) => [g.faction, g.missionType].filter(Boolean).join(" · ") || t("unlock.otherGroup");
const rankSpan = (g: UnlockMissionGroup) => (g.rankFrom === g.rankTo ? g.rankFrom : `${g.rankFrom} – ${g.rankTo}`);
// Systems, then the place the contract is bound to
const placeText = (r: UnlockMissionRow) => [r.systems.join(", "), r.locations.join(", ")].filter(Boolean).join(" · ") || "—";
</script>

<template>
  <ConfirmDialog :title="name" :subtitle="t('unlock.title')" icon="lock" :buttons="buttons" xl @choose="emit('close')">
    <div v-if="!data" class="empty-line">{{ t("common.loading") }}</div>
    <div v-else-if="!data.sections.length" class="empty-line">{{ t("unlock.none") }}</div>
    <section v-for="s in data?.sections ?? []" :key="s.kind" class="kind">
      <div class="section">{{ kindCount(s.kind, s.count) }}</div>

      <template v-if="s.kind === 'mission'">
        <div v-for="(g, i) in s.groups" :key="i" class="group">
          <button type="button" class="group-head" :aria-expanded="open.has(i)" @click="toggle(i)">
            <Icon :name="open.has(i) ? 'chevron-down' : 'chevron-right'" :size="14" />
            <span class="group-name">{{ groupName(g) }}</span>
            <span class="tag">{{ g.count }}</span>
            <span v-if="g.systems.length" class="dim">{{ g.systems.join(", ") }}</span>
            <span v-if="rankSpan(g)" class="dim">{{ rankSpan(g) }}</span>
            <span class="spacer" />
            <span class="odds">{{ bestText(g) }}</span>
          </button>
          <div v-if="open.has(i)" class="rows">
            <span class="cell head">{{ t("unlock.col.mission") }}</span>
            <span class="cell head">{{ t("unlock.col.rank") }}</span>
            <span class="cell head">{{ t("unlock.col.system") }}</span>
            <span class="cell head" />
            <span class="cell head right">{{ t("unlock.col.chance") }}</span>
            <template v-for="(r, k) in g.rows" :key="k">
              <span class="cell title">{{ r.title }}<span v-if="r.count > 1" class="faint"> ×{{ r.count }}</span></span>
              <span class="cell">{{ r.rank ?? "—" }}</span>
              <span class="cell">{{ placeText(r) }}</span>
              <span class="cell markers">
                <span v-for="m in r.markers" :key="m" class="tag" :class="markerClass(m)">{{ markerText(m) }}</span>
                <span v-if="r.event" class="tag warn">{{ r.event }}</span>
              </span>
              <span class="cell right odds">{{ oddsText(r.odds) }}</span>
            </template>
          </div>
        </div>
      </template>

      <ul v-else class="tiers">
        <li v-for="(e, k) in s.tiers" :key="k">
          <span class="tag warn">{{ e.event }}</span>
          <span v-if="e.minPoints !== null">{{ pointsText(e.minPoints) }}</span>
          <span v-if="e.count > 1" class="faint">×{{ e.count }}</span>
          <span class="spacer" />
          <span class="odds">{{ oddsText(e.odds) }}</span>
        </li>
      </ul>
    </section>
  </ConfirmDialog>
</template>

<style scoped>
.kind {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.section {
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: var(--text-3);
}

.group {
  border: 1px solid var(--border-dim);
  border-radius: var(--radius-control);
}

.group-head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 8px 10px;
  border: none;
  background: none;
  color: var(--text);
  font: inherit;
  font-size: 13px;
  text-align: left;
  cursor: pointer;
}

.group-head:hover {
  background: var(--bg-surface-2);
}

.group-name {
  font-weight: 600;
}

.odds {
  white-space: nowrap;
  color: var(--text);
}

/* One grid for all rows (columns line up); scrolls inside, the head row stays */
.rows {
  display: grid;
  grid-template-columns: minmax(160px, 3fr) minmax(90px, 1.3fr) minmax(70px, 1fr) max-content max-content;
  max-height: 360px;
  overflow-y: auto;
  border-top: 1px solid var(--border-dim);
  font-size: 12px;
}

.cell {
  display: flex;
  align-items: center;
  min-width: 0;
  padding: 5px 10px;
  border-bottom: 1px solid var(--border-dim);
  color: var(--text-2);
  overflow-wrap: anywhere;
}

.cell.head {
  position: sticky;
  top: 0;
  z-index: 1;
  background: var(--bg-surface);
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: var(--text-3);
}

.cell.title {
  display: block;
  color: var(--text);
}

.cell.right {
  justify-content: flex-end;
}

.markers {
  gap: 4px;
}

.tiers {
  margin: 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 13px;
}

.tiers li {
  display: flex;
  align-items: center;
  gap: 8px;
}
</style>
