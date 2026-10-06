<script setup lang="ts">
// Data from third parties: the UEX pull (status, refinery terminals with their catalog match,
// yield bonuses, refining methods).
import Icon from "../components/Icon.vue";
import { useFetch } from "../api";
import { dateTime, duration } from "../format";
import type { UexResponse } from "../../../src/adminapp/api-types";

const uex = useFetch<UexResponse>(() => "/ext/uex");

// "Agricium (Ore)" -> "Agricium" for the column heads; the full name stays in the tooltip
const short = (ore: string) => ore.replace(/\s*\((Ore|Raw)\)$/, "");
const signed = (v: number) => (v > 0 ? `+${v}` : String(v));
</script>

<template>
  <div class="view">
    <div class="stack">
      <div v-if="uex.error.value" class="panel"><div class="empty-line">{{ uex.error.value }}</div></div>
      <template v-else-if="uex.data.value">
        <section class="panel">
          <div class="head"><Icon name="refresh" :size="16" /><span class="head-title">UEX pull</span></div>
          <div v-if="!uex.data.value.endpoints.length" class="empty-line">No UEX data yet</div>
          <table v-else class="mini">
            <thead><tr><th>Endpoint</th><th class="num">Rows</th><th class="num">Snapshots</th><th>Changed</th><th>Checked</th></tr></thead>
            <tbody>
              <tr v-for="e in uex.data.value.endpoints" :key="e.endpoint">
                <td class="mono">{{ e.endpoint }}</td>
                <td class="num mono">{{ e.rows }}</td>
                <td class="num mono">{{ e.snapshots }}</td>
                <td>{{ dateTime(e.changedAt) }}</td>
                <td>{{ dateTime(e.checkedAt) }}</td>
              </tr>
            </tbody>
          </table>
        </section>

        <section v-if="uex.data.value.refineries.length" class="panel">
          <div class="head"><Icon name="drop" :size="16" /><span class="head-title">Refineries</span></div>
          <table class="mini">
            <thead><tr><th>UEX terminal</th><th>System</th><th>Catalog location</th></tr></thead>
            <tbody>
              <tr v-for="r in uex.data.value.refineries" :key="r.terminalId">
                <td :title="r.terminal">{{ r.place }}</td>
                <td>{{ r.system }}</td>
                <td>
                  <span v-if="r.location" :title="r.locationUuid ?? ''">{{ r.location }}</span>
                  <span v-else class="tag warn">Not matched</span>
                </td>
              </tr>
            </tbody>
          </table>
        </section>

        <section v-if="uex.data.value.refineries.length" class="panel">
          <div class="head"><Icon name="bolt" :size="16" /><span class="head-title">Yield bonus %</span></div>
          <div class="scroll-x">
            <table class="mini matrix">
              <thead>
                <tr>
                  <th>Refinery</th>
                  <th v-for="o in uex.data.value.ores" :key="o" class="num" :title="o">{{ short(o) }}</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="r in uex.data.value.refineries" :key="r.terminalId">
                  <td class="nowrap" :title="r.terminal">{{ r.place }} <span class="faint">{{ r.system }}</span></td>
                  <td
                    v-for="o in uex.data.value.ores"
                    :key="o"
                    class="num mono"
                    :class="{ pos: (r.yields[o] ?? 0) > 0, neg: (r.yields[o] ?? 0) < 0, faint: r.yields[o] === undefined }"
                  >
                    {{ r.yields[o] === undefined ? "–" : signed(r.yields[o]) }}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </section>

        <section v-if="uex.data.value.methods.length" class="panel">
          <div class="head"><Icon name="crafter" :size="16" /><span class="head-title">Refining methods</span></div>
          <table class="mini">
            <thead>
              <tr>
                <th>Method</th><th>Code</th><th class="num">UEX yield</th><th class="num">UEX cost</th><th class="num">UEX speed</th>
                <th class="num">Yield %</th><th class="num">Time / SCU</th><th>Source</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="m in uex.data.value.methods" :key="m.code">
                <td>{{ m.name }}</td>
                <td class="mono dim">{{ m.code }}</td>
                <td class="num mono">{{ m.ratingYield ?? "–" }}</td>
                <td class="num mono">{{ m.ratingCost ?? "–" }}</td>
                <td class="num mono">{{ m.ratingSpeed ?? "–" }}</td>
                <td class="num mono">{{ m.yieldPct ?? "–" }}</td>
                <td class="num mono">{{ m.secondsPerScu === null ? "–" : duration(m.secondsPerScu) }}</td>
                <td class="dim">{{ m.source ?? "" }}</td>
              </tr>
            </tbody>
          </table>
        </section>
      </template>
      <div v-else class="panel"><div class="empty-line">Loading…</div></div>
    </div>
  </div>
</template>

<style scoped>
.scroll-x {
  overflow-x: auto;
}

.matrix th.num {
  white-space: nowrap;
}

.nowrap {
  white-space: nowrap;
}

.pos {
  color: var(--ok);
}

.neg {
  color: var(--err);
}
</style>
