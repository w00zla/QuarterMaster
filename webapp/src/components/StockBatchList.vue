<script setup lang="ts">
// The stored batches of one crafting material at or above the target quality: who holds it (and the
// orgs it is shared in), quality and amount.
import type { StockBatch } from "../../../src/webapp/api-types";
import { qMark, qty } from "../format";
import { t } from "../i18n";
import { orgOf } from "../orgs";
import { me } from "../session";

defineProps<{ rows: StockBatch[] }>();

/** "Me", or "Max · Hurston Haulers" */
const holderText = (b: StockBatch) => b.holderUserId === me.value?.userId ? t("crafting.me")
  : [b.holderName ?? "?", ...b.sharedIn.map((g) => orgOf(g)?.name).filter(Boolean)].join(" · ");
</script>

<template>
  <div v-if="rows.length" class="batches">
    <div v-for="b in rows" :key="b.id" class="batch">
      <span class="who">
        <span class="holder" :title="holderText(b)">{{ holderText(b) }}</span>
      </span>
      <span class="qcell"><span>{{ qMark(b.quality) }}</span><span>{{ b.quality }}</span></span>
      <span class="mono amount">{{ qty(b.quantity, b.unit) }}</span>
    </div>
  </div>
</template>

<style scoped>
.batches {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 9ch minmax(9ch, auto);
  /* No column gap: the space between columns is padding */
  gap: 0;
  font-size: 12px;
}

.batch {
  display: contents;
}

/* No lines between the batches: the material line above them (PlanEntryCard) is the only one */
.batch > * {
  padding: 3px 0;
  align-self: stretch;
  display: flex;
  align-items: center;
}

.batch > :not(:last-child) {
  padding-right: 12px;
}

.batch > .who {
  flex-direction: column;
  align-items: stretch;
  justify-content: center;
  min-width: 0;
}

.holder {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text-2);
}

.batch > .qcell {
  display: grid;
  align-content: center;
  color: var(--text-2);
}

.amount {
  justify-content: flex-end;
  color: var(--text);
}
</style>
