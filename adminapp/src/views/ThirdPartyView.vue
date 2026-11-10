<script setup lang="ts">
// UEX data: the pull (status per endpoint) and how far its trade data cover the catalog.
import { RouterLink } from "vue-router";
import HelpTip from "../components/HelpTip.vue";
import Icon from "../components/Icon.vue";
import { useFetch } from "../api";
import { dateTime } from "../format";
import { HELP } from "../help";
import type { UexResponse, UexTradeResponse } from "../../../src/adminapp/api-types";

const uex = useFetch<UexResponse>(() => "/ext/uex");
const trade = useFetch<UexTradeResponse>(() => "/ext/uex/trade");
const n = (v: number) => v.toLocaleString();
</script>

<template>
  <div class="view">
    <div class="stack scroll">
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

        <section v-if="uex.data.value.endpoints.length" class="panel">
          <div class="head">
            <Icon name="link" :size="16" />
            <span class="head-title no-grow">Trade coverage</span>
            <HelpTip :text="HELP.tradeCoverage" />
          </div>
          <div v-if="trade.error.value" class="empty-line">{{ trade.error.value }}</div>
          <div v-else-if="!trade.data.value" class="empty-line">Loading…</div>
          <div v-else class="pad coverage">
            <dl class="kv">
              <dt>Terminals</dt>
              <dd>{{ n(trade.data.value.terminals) }} <span class="faint">· price rows: {{ n(trade.data.value.commodityPrices) }} commodities, {{ n(trade.data.value.itemPrices) }} items</span></dd>
              <dt>Commodities</dt>
              <dd>{{ n(trade.data.value.commodities.matched) }} of {{ n(trade.data.value.commodities.total) }} matched to a resource</dd>
              <dt>Resources</dt>
              <dd>
                {{ n(trade.data.value.resources.matched) }} of {{ n(trade.data.value.resources.total) }} with a commodity
                <span class="faint">· {{ n(trade.data.value.resources.priced) }} with prices</span>
              </dd>
              <dt>Items</dt>
              <dd>
                {{ n(trade.data.value.items.gearPriced) }} of {{ n(trade.data.value.items.gear) }} gear items with prices
                <span class="faint">· {{ n(trade.data.value.items.priced) }} items with prices in all</span>
              </dd>
            </dl>
            <div v-if="trade.data.value.commodities.unmatched.length" class="block">
              <span class="panel-title">Commodities not matched · {{ trade.data.value.commodities.unmatched.length }}</span>
              <div class="names"><span v-for="c in trade.data.value.commodities.unmatched" :key="c">{{ c }}</span></div>
            </div>
            <div v-if="trade.data.value.resources.unmatched.length" class="block">
              <span class="panel-title">Resources without a commodity · {{ trade.data.value.resources.unmatched.length }}</span>
              <div class="names">
                <RouterLink v-for="r in trade.data.value.resources.unmatched" :key="r.uuid" :to="`/materials/${r.uuid}`">{{ r.name }}</RouterLink>
              </div>
            </div>
          </div>
        </section>

      </template>
      <div v-else class="panel"><div class="empty-line">Loading…</div></div>
    </div>
  </div>
</template>

<style scoped>
.scroll {
  overflow: auto;
}

.scroll > .panel {
  flex-shrink: 0;
}

.pad {
  padding: 12px 16px 14px;
}

.coverage {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.block {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.names {
  display: flex;
  flex-wrap: wrap;
  gap: 2px 14px;
  font-size: 12px;
  color: var(--text-2);
}
</style>
