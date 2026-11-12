<script setup lang="ts">
// Bergbau/Mining: the signature scan (mining.ts). In the head after the count the chip "Radar-Signatur" switches the
// scan to the radar signature alone (on: the live colour with a check, off: dashed with an x, like the refinery's
// filter), a dim line after it says that it switches the other scans off; on the right a button empties the list.
// Two tiles: the newest signature as the game writes it and the resources it can stand for. Below them the latest
// signatures, newest first: time, signature, resources. The overlay's Bergbau view gets the same rows.
import { computed, watchEffect } from "vue";
import Icon from "../../../adminapp/src/components/Icon.vue";
import Tooltip from "../../../adminapp/src/components/Tooltip.vue";
import { langRef, t } from "../i18n";
import { clearHistory, history, matchesOf, METHOD_ICONS, noMatchText, signatureOn, toggleSignature } from "../mining";
import { overlayRows, tabCounts } from "../overlay";
import { matchText, signatureText } from "../signatures";

const time = (ms: number) => new Date(ms).toLocaleTimeString(langRef.value, { hour: "2-digit", minute: "2-digit", second: "2-digit" });

const rows = computed(() => history.value.map((e) => ({ atMs: e.atMs, value: signatureText(e.value), matches: matchesOf(e.value) })));
const newest = computed(() => history.value[0] ?? null);
const newestMatches = computed(() => (newest.value ? matchesOf(newest.value.value) : []));

// The overlay's Bergbau view: the signature, its resources after their mining method's icon
watchEffect(() => {
  overlayRows.mining = rows.value.map((r) => ({
    tag: "", cls: "", name: r.value, detail: null, cols: [],
    parts: r.matches.length ? r.matches.map((m) => ({ text: matchText(m), icon: METHOD_ICONS[m.method] })) : [{ text: noMatchText(), icon: null }],
  }));
  tabCounts.mining = history.value.length;
});
</script>

<template>
  <section class="panel mining">
    <div class="head">
      <span class="head-title no-grow">{{ t("mining.title") }} <span class="head-count">{{ history.length }}</span></span>
      <div class="chips filter">
        <Tooltip :text="t(signatureOn ? 'filter.on' : 'filter.off')">
          <button type="button" class="chip" :class="{ active: signatureOn }" :aria-pressed="signatureOn" @click="toggleSignature">
            <Icon name="target" :size="12" /> {{ t("mining.signatureScan") }}
            <Icon :name="signatureOn ? 'check' : 'close'" :size="12" />
          </button>
        </Tooltip>
      </div>
      <span class="hint">{{ t("mining.signatureHint") }}</span>
      <Tooltip :text="t('mining.clear')">
        <button type="button" class="icon-btn" :aria-label="t('mining.clear')" :disabled="!history.length" @click="clearHistory">
          <Icon name="trash" :size="14" />
        </button>
      </Tooltip>
    </div>
    <div class="tiles">
      <div class="tile">
        <span class="caption">{{ t("mining.signature") }}</span>
        <span class="value num">{{ newest ? signatureText(newest.value) : "–" }}</span>
      </div>
      <div class="tile">
        <span class="caption">{{ t("mining.resources") }}</span>
        <template v-if="newest">
          <span v-for="(m, i) in newestMatches" :key="i" class="resource">
            <Icon :name="METHOD_ICONS[m.method]" :size="14" class="method" />{{ matchText(m) }}
          </span>
          <span v-if="!newestMatches.length" class="resource warn">{{ noMatchText() }}</span>
        </template>
        <span v-else class="resource">–</span>
      </div>
    </div>
    <div v-if="!history.length" class="empty-line">{{ t("mining.empty") }}</div>
    <div v-else class="list">
      <div class="list-row list-head">
        <span>{{ t("mining.col.time") }}</span>
        <span class="right">{{ t("mining.signature") }}</span>
        <span>{{ t("mining.resources") }}</span>
      </div>
      <div class="list-body">
        <div v-for="r in rows" :key="r.atMs" class="list-row">
          <span class="mono">{{ time(r.atMs) }}</span>
          <span class="num right">{{ r.value }}</span>
          <span v-if="r.matches.length" class="clip matches">
            <span v-for="(m, i) in r.matches" :key="i" class="match">
              <Icon :name="METHOD_ICONS[m.method]" :size="12" class="method" />{{ matchText(m) }}
            </span>
          </span>
          <span v-else class="clip warn">{{ noMatchText() }}</span>
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
/* Fills the main area, only its list scrolls */
.mining {
  flex: 1;
  min-height: 0;
}

/* The chip in the head after the count, like the refinery's filter: on = the live colour with a check, off =
   dashed and dimmed with an x */
.filter {
  align-items: center;
  gap: 6px;
  font-size: 11px;
}

.filter .chip {
  height: 22px;
  gap: 4px;
  padding: 0 8px;
  font-size: 11px;
  border-style: dashed;
  color: var(--text-3);
}

.filter .chip.active {
  border-style: solid;
  border-color: color-mix(in srgb, var(--live) 45%, transparent);
  background: color-mix(in srgb, var(--live) 14%, transparent);
  color: var(--live);
}

/* The dim line after the chip takes the room left and clips */
.hint {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 11px;
  color: var(--text-3);
}

.tiles {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
  padding: 12px 16px;
  border-top: 1px solid var(--border-dim);
}

.tile {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
  padding: 10px 12px;
  border-radius: var(--radius-control);
  background: var(--bg-surface-2);
}

.caption {
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: var(--text-2);
}

.value {
  font-size: 22px;
  font-weight: 600;
  line-height: 1.2;
}

.resource {
  font-size: 15px;
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.warn {
  color: var(--warn);
}

.resource.warn {
  font-weight: 400;
}

/* The latest signatures: compact rows like the other tables, only the rows scroll */
.list {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  border-top: 1px solid var(--border-dim);
}

.list-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
}

.list-row {
  display: grid;
  grid-template-columns: 76px 80px minmax(0, 1fr);
  gap: 8px;
  align-items: center;
  padding: 4px 16px;
  border-bottom: 1px solid var(--border-dim);
  font-size: 12px;
}

.list-head {
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: var(--text-2);
}

.right {
  text-align: right;
}

.mono {
  font-family: var(--font-mono);
  color: var(--text-2);
}

.clip {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* A resource after its mining method's icon */
.resource,
.match {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}

.matches {
  display: flex;
  gap: 12px;
}

.method {
  flex-shrink: 0;
  color: var(--text-2);
}
</style>
