<script setup lang="ts">
// Stored stock per material, one table per group (resources, harvestables, gear). `org`: the stock shared in
// an org (owners per material) instead of a user's own (batches shared anywhere).
import { computed } from "vue";
import type { MaterialTotal, StockGroup } from "../../../src/adminapp/api-types";

const props = defineProps<{ stock: MaterialTotal[]; org?: boolean }>();

const GROUPS: { key: StockGroup; label: string }[] = [
  { key: "resource", label: "Resources" },
  { key: "harvestable", label: "Harvestables" },
  { key: "gear", label: "Gear" },
];

const groups = computed(() => GROUPS
  .map((g) => ({ ...g, rows: props.stock.filter((s) => s.group === g.key) }))
  .filter((g) => g.rows.length));

const quality = (s: MaterialTotal) => (s.minQuality === s.maxQuality ? s.minQuality : `${s.minQuality}–${s.maxQuality}`);
</script>

<template>
  <div v-if="!groups.length" class="faint">None</div>
  <section v-for="g in groups" :key="g.key">
    <span class="panel-title">{{ g.label }} <span class="faint">{{ g.rows.length }}</span></span>
    <table class="mini">
      <thead>
        <tr>
          <th>Material</th><th class="num">Amount</th><th class="num">Batches</th>
          <th class="num">{{ org ? "Owners" : "Shared" }}</th><th v-if="g.key !== 'gear'" class="num">Quality</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="s in g.rows" :key="s.uuid">
          <td>{{ s.name }}</td>
          <td class="num mono">{{ s.total }} {{ s.unit }}</td>
          <td class="num mono">{{ s.batches }}</td>
          <td v-if="org" class="num mono">{{ s.owners }}</td>
          <td v-else class="num mono" :class="{ faint: !s.shared }">{{ s.shared }}</td>
          <td v-if="g.key !== 'gear'" class="num mono">{{ quality(s) }}</td>
        </tr>
      </tbody>
    </table>
  </section>
</template>
