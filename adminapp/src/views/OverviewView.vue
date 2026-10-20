<script setup lang="ts">
// The essentials at a glance. Ordering: by count, largest first; sources by priority.
import { computed } from "vue";
import { RouterLink, useRouter } from "vue-router";
import HelpTip from "../components/HelpTip.vue";
import Icon from "../components/Icon.vue";
import { useFetch } from "../api";
import { dateTime, duration, sourceTag } from "../format";
import { HELP } from "../help";
import type { DataCheck, DataCheckKey, Overview } from "../../../src/adminapp/api-types";

const router = useRouter();
const overview = useFetch<Overview>(() => "/overview");
const checks = useFetch<DataCheck[]>(() => "/checks");

// User data the catalog or the UEX refinery data no longer backs
const CHECKS: Record<DataCheckKey, string> = {
  retiredMaterial: "Resources of retired materials",
  retiredLocation: "Resources at retired locations",
  retiredBlueprint: "Registered retired blueprints",
  overdueJob: "Refinery jobs ready for over a week",
  jobNotAtRefinery: "Refinery jobs outside the UEX refineries",
};

// The three catalog parts that matter, as tiles; everything else as a subtext line
const MAIN: Record<string, { label: string; to: string; help: string }> = {
  blueprint: { label: "Blueprints", to: "/blueprints", help: HELP.blueprints },
  item: { label: "Items", to: "/items", help: HELP.items },
  resource: { label: "Resources", to: "/resources", help: HELP.resources },
};
const MINOR: Record<string, { label: string; help: string }> = {
  manufacturer: { label: "manufacturers", help: HELP.manufacturers },
  blueprintCategory: { label: "categories", help: HELP.categories },
  craftedProperty: { label: "stats", help: HELP.stats },
  qualityQuantization: { label: "quality tables", help: HELP.qualityTables },
  rawRecord: { label: "raw records", help: HELP.rawRecords },
};
const TEXT_ENTITIES: Record<string, string> = {
  item: "Item names",
  resource: "Resource names",
  slot: "Slot names",
  stat: "Stat names",
  type: "Item types",
  category: "Categories",
};

const data = computed(() => overview.data.value);
const main = computed(() => (data.value?.counts ?? []).filter((c) => MAIN[c.entity]));
const minor = computed(() => (data.value?.counts ?? []).filter((c) => MINOR[c.entity]));
const maxCategory = computed(() => Math.max(1, ...(data.value?.categories ?? []).map((c) => c.count)));
const maxMaterial = computed(() => Math.max(1, ...(data.value?.topMaterials ?? []).map((m) => m.recipes)));
const priority = (min: number, max: number) => (min === max ? String(min) : `${min}–${max}`);
</script>

<template>
  <div class="view">
    <div v-if="overview.error.value" class="empty-line">{{ overview.error.value }}</div>
    <div v-else-if="data" class="stack scroll">
      <section class="panel">
        <div class="head">
          <Icon name="overview" :size="16" />
          <span class="head-title">Catalog</span>
        </div>
        <div class="tiles">
          <button v-for="c in main" :key="c.entity" type="button" class="tile" @click="router.push(MAIN[c.entity]!.to)">
            <span class="tile-label">
              <span class="panel-title">{{ MAIN[c.entity]!.label }}</span>
              <HelpTip :text="MAIN[c.entity]!.help" />
            </span>
            <span class="tile-value">{{ c.active.toLocaleString() }}</span>
            <span v-if="c.retired" class="faint inline">{{ c.retired }} retired <HelpTip :text="HELP.retired" /></span>
          </button>
        </div>
        <div class="minor">
          <span v-for="c in minor" :key="c.entity" class="inline">
            {{ c.active.toLocaleString() }} {{ MINOR[c.entity]!.label }} <HelpTip :text="MINOR[c.entity]!.help" />
          </span>
        </div>
      </section>

      <section class="panel">
        <div class="head">
          <Icon name="warning" :size="16" />
          <span class="head-title">User data checks</span>
        </div>
        <div v-if="checks.error.value" class="empty-line">{{ checks.error.value }}</div>
        <div v-else-if="checks.data.value" class="pad checks">
          <div v-for="c in checks.data.value" :key="c.key" class="check">
            <div class="check-row">
              <span>{{ CHECKS[c.key] }}</span>
              <span class="spacer" />
              <span class="mono" :class="c.hits.length ? 'tag warn' : 'faint'">{{ c.hits.length }}</span>
            </div>
            <table v-if="c.hits.length" class="mini">
              <thead><tr><th>User</th><th>Subject</th><th>Location</th><th class="num">Amount</th><th v-if="c.key === 'overdueJob'">Ready</th></tr></thead>
              <tbody>
                <tr v-for="(h, i) in c.hits" :key="i" class="link" @click="router.push(`/users/${h.userId}`)">
                  <td><span v-if="h.name">{{ h.name }}</span><span v-else class="mono faint">{{ h.userId }}</span></td>
                  <td>{{ h.subject }}</td>
                  <td class="dim">{{ h.location ?? "" }}</td>
                  <td class="num mono">{{ h.amount ? `${h.amount} ${h.unit}` : "" }}</td>
                  <td v-if="c.key === 'overdueJob'">{{ dateTime(h.endsAt) }}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
        <div v-else class="empty-line">Loading…</div>
      </section>

      <div class="columns">
        <section class="panel grow">
          <div class="head">
            <Icon name="list" :size="16" />
            <span class="head-title">Recipes</span>
          </div>
          <dl class="kv pad">
            <dt>Without a known source <HelpTip :text="HELP.noSource" /></dt>
            <dd>{{ data.gaps.noSourceBlueprints }}</dd>
            <dt>… registered by users <HelpTip :text="HELP.registeredNoSource" /></dt>
            <dd :class="{ faint: !data.gaps.registeredNoSource.length }">
              <template v-if="!data.gaps.registeredNoSource.length">0</template>
              <template v-for="(b, i) in data.gaps.registeredNoSource" :key="b.uuid">
                <template v-if="i">, </template>
                <RouterLink :to="`/blueprints/${b.uuid}`">{{ b.name }}</RouterLink> <span class="faint">({{ b.users }})</span>
              </template>
            </dd>
            <dt>Default blueprints <HelpTip :text="HELP.defaultBlueprint" /></dt>
            <dd>{{ data.facts.defaultBlueprints }}</dd>
            <dt>Quality-gated <HelpTip :text="HELP.qualityGated" /></dt>
            <dd>{{ data.facts.qualityGated }}</dd>
            <dt>With slot choice <HelpTip :text="HELP.slotsRequired" /></dt>
            <dd>{{ data.facts.slotChoice }}</dd>
            <dt>Without output</dt>
            <dd :class="{ faint: !data.gaps.noOutputBlueprints }">{{ data.gaps.noOutputBlueprints }}</dd>
            <dt>Crafting time</dt>
            <dd>
              average {{ duration(data.facts.avgCraftSeconds) }}
              <template v-if="data.facts.longestCraft">
                · longest {{ duration(data.facts.longestCraft.seconds) }}
                (<RouterLink :to="`/blueprints/${data.facts.longestCraft.uuid}`">{{ data.facts.longestCraft.name }}</RouterLink>)
              </template>
            </dd>
            <template v-if="data.facts.lastImport">
              <dt>Last import <HelpTip :text="HELP.importCounts" /></dt>
              <dd>
                <RouterLink :to="`/imports/${data.facts.lastImport.id}`">#{{ data.facts.lastImport.id }}</RouterLink>
                · +{{ data.facts.lastImport.added }} ~{{ data.facts.lastImport.changed }} −{{ data.facts.lastImport.retired }}
                <template v-if="data.facts.lastImport.revived"> ↺{{ data.facts.lastImport.revived }}</template>
              </dd>
            </template>
          </dl>
        </section>

        <section class="panel grow">
          <div class="head">
            <Icon name="warning" :size="16" />
            <span class="head-title no-grow">Gaps</span>
            <HelpTip :text="HELP.gaps" />
          </div>
          <div class="pad">
            <table class="mini">
              <thead>
                <tr><th>Without text</th><th class="num">in <span class="mono">{{ data.gaps.lang }}</span></th><th class="num">anywhere</th><th class="num">of</th></tr>
              </thead>
              <tbody>
                <tr v-for="t in data.gaps.texts" :key="t.entity">
                  <td>{{ TEXT_ENTITIES[t.entity] ?? t.entity }}</td>
                  <td class="num mono" :class="{ faint: !t.missingInLang }">{{ t.missingInLang }}</td>
                  <td class="num mono" :class="{ faint: !t.missingEverywhere }">{{ t.missingEverywhere }}</td>
                  <td class="num mono faint">{{ t.total }}</td>
                </tr>
              </tbody>
            </table>
            <dl class="kv unused">
              <dt>Resources in no recipe <HelpTip :text="HELP.unusedResources" /></dt>
              <dd>{{ data.gaps.unusedResources }} <span class="faint">({{ data.gaps.unusedOres }} ores)</span></dd>
              <dt>Materials in recipes</dt>
              <dd>{{ data.facts.resourcesInRecipes }} resources · {{ data.facts.itemsInRecipes }} items</dd>
            </dl>
          </div>
        </section>
      </div>

      <div class="columns">
        <section class="panel grow">
          <div class="head">
            <Icon name="blueprint" :size="16" />
            <span class="head-title no-grow">Blueprints by category</span>
            <HelpTip :text="HELP.categories" />
          </div>
          <div class="bars pad">
            <div v-for="c in data.categories" :key="c.group" class="bar-row">
              <span class="bar-label">{{ c.label }}</span>
              <span class="bar"><span class="bar-fill" :style="{ width: `${(c.count / maxCategory) * 100}%` }" /></span>
              <span class="mono num">{{ c.count }}</span>
            </div>
          </div>
        </section>

        <section class="panel grow">
          <div class="head">
            <Icon name="resource" :size="16" />
            <span class="head-title no-grow">Most used materials</span>
            <HelpTip :text="HELP.topMaterials" />
          </div>
          <div class="bars pad">
            <div v-for="m in data.topMaterials" :key="`${m.kind}:${m.uuid}`" class="bar-row">
              <RouterLink class="bar-label" :to="`/${m.kind === 'resource' ? 'resources' : 'items'}/${m.uuid}`">{{ m.name }}</RouterLink>
              <span class="bar"><span class="bar-fill" :style="{ width: `${(m.recipes / maxMaterial) * 100}%` }" /></span>
              <span class="mono num">{{ m.recipes }}</span>
            </div>
          </div>
        </section>
      </div>

      <div class="columns">
        <section class="panel grow">
          <div class="head">
            <Icon name="imports" :size="16" />
            <span class="head-title no-grow">Latest imports</span>
            <HelpTip :text="HELP.anomalies" />
            <div class="spacer" />
            <button type="button" class="btn outline small" @click="router.push('/imports')">All</button>
          </div>
          <div class="pad">
            <table v-if="data.imports.length" class="mini">
              <thead><tr><th class="num">#</th><th>Imported</th><th>Game</th><th class="num">Anomalies</th></tr></thead>
              <tbody>
                <tr v-for="i in data.imports" :key="i.id" class="link" @click="router.push(`/imports/${i.id}`)">
                  <td class="num mono">{{ i.id }}</td>
                  <td>{{ dateTime(i.importedAt) }}</td>
                  <td><span class="mono">{{ i.channel }} {{ i.gameBuild }}</span> <span class="dim">{{ i.gameLabel ?? "" }}</span></td>
                  <td class="num mono">{{ i.anomalyCount }}</td>
                </tr>
              </tbody>
            </table>
            <div v-else class="empty-line">No imports yet</div>
          </div>
        </section>

        <section class="panel grow">
          <div class="head">
            <Icon name="texts" :size="16" />
            <span class="head-title no-grow">Text sources</span>
            <HelpTip :text="HELP.sources" />
            <div class="spacer" />
            <button type="button" class="btn outline small" @click="router.push('/localisation')">Localisation</button>
          </div>
          <div class="pad sources">
            <div v-for="s in data.sources" :key="s.source" class="source-row">
              <span class="tag" :class="sourceTag(s.source)">{{ s.source }}</span>
              <span class="dim">{{ s.langs.length > 3 ? `${s.langs.length} languages` : s.langs.join(", ") }}</span>
              <span class="faint">priority {{ priority(s.minPriority, s.maxPriority) }}</span>
              <span class="spacer" />
              <span class="mono">{{ s.keyCount.toLocaleString() }}</span>
            </div>
          </div>
        </section>
      </div>
    </div>
    <div v-else class="empty-line">Loading…</div>
  </div>
</template>

<style scoped>
.scroll {
  overflow: auto;
}

.checks {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.check {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.check-row {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 20px;
}

.tiles {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 8px;
  padding: 12px 16px 8px;
}

.tile {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 4px;
  padding: 12px 14px;
  border-radius: var(--radius-control);
  border: 1px solid var(--border-dim);
  background: transparent;
  color: var(--text);
  font-family: inherit;
  font-size: 12px;
  text-align: left;
  cursor: pointer;
}

.tile:hover {
  background: var(--bg-surface-2);
}

.tile-label,
.inline {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}

.tile-value {
  font-size: 28px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}

.minor {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 18px;
  padding: 0 16px 14px;
  font-size: 12px;
  color: var(--text-2);
}

.columns {
  display: flex;
  gap: 12px;
  flex-shrink: 0;
}

.grow {
  flex: 1;
  min-width: 0;
}

.pad {
  padding: 12px 16px 14px;
}

.unused {
  margin-top: 12px;
}

.bars {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.bar-row {
  display: grid;
  grid-template-columns: 170px minmax(0, 1fr) 44px;
  gap: 10px;
  align-items: center;
  font-size: 13px;
}

.bar-label {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.bar {
  height: 6px;
  border-radius: 3px;
  background: var(--bg-surface-2);
  overflow: hidden;
}

.bar-fill {
  display: block;
  height: 100%;
  background: var(--accent);
}

.sources {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.source-row {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 13px;
}
</style>
