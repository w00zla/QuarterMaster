<script setup lang="ts">
// Is everything running and do the data hold: services (catalog, UEX pull, the bot's logs channels),
// the user data checks, the catalog's counts and gaps, the item thumbnails' coverage. Ordering: by state, then by name.
import { ref } from "vue";
import { RouterLink, useRouter } from "vue-router";
import HelpTip from "../components/HelpTip.vue";
import Icon from "../components/Icon.vue";
import { useFetch } from "../api";
import { ago, dateTime } from "../format";
import { HELP } from "../help";
import type { DataCheck, DataCheckKey, Health, Overview, StatusResponse, ThumbsResponse } from "../../../src/adminapp/api-types";

const router = useRouter();
const status = useFetch<StatusResponse>(() => "/status", false);
const checks = useFetch<DataCheck[]>(() => "/checks");
const overview = useFetch<Overview>(() => "/overview");
const thumbs = useFetch<ThumbsResponse>(() => "/thumbs");
// Items and materials without a thumbnail: a closed list, opened it scrolls after five rows
const missingOpen = ref(false);

function reload() {
  status.reload();
  checks.reload();
  overview.reload();
  thumbs.reload();
}

const STATE: Record<Health, string> = { ok: "OK", warn: "Late", err: "Stale" };

// User data the catalog or the UEX refinery data no longer backs
const CHECKS: Record<DataCheckKey, string> = {
  retiredMaterial: "Resources of retired materials",
  retiredLocation: "Resources at retired locations",
  retiredBlueprint: "Registered retired blueprints",
  jobNotAtRefinery: "Refinery orders outside the UEX refineries",
};

// The three catalog parts that matter, as tiles; everything else as a subtext line
const MAIN: Record<string, { label: string; to: string; help: string }> = {
  blueprint: { label: "Blueprints", to: "/blueprints", help: HELP.blueprints },
  item: { label: "Items", to: "/items", help: HELP.items },
  resource: { label: "Materials", to: "/materials", help: HELP.resources },
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
  resource: "Material names",
  slot: "Slot names",
  stat: "Stat names",
  type: "Item types",
  category: "Categories",
};
</script>

<template>
  <div class="view">
    <div class="stack scroll">
      <section class="panel">
        <div class="head">
          <Icon name="status" :size="16" />
          <span class="head-title no-grow">Services</span>
          <span v-if="status.data.value" class="head-count">checked {{ dateTime(status.data.value.checkedAt) }}</span>
          <div class="spacer" />
          <button type="button" class="btn outline small" @click="reload"><Icon name="refresh" :size="14" /> Refresh</button>
        </div>
        <div v-if="status.error.value" class="empty-line">{{ status.error.value }}</div>
        <div v-else-if="status.data.value" class="pad services">
          <dl class="kv">
            <dt>Catalog</dt>
            <dd>
              <template v-if="status.data.value.game">
                <RouterLink :to="`/imports/${status.data.value.game.importId}`" class="mono">
                  {{ status.data.value.game.channel }} {{ status.data.value.game.label ?? "" }} · {{ status.data.value.game.build }}
                </RouterLink>
                <span class="faint"> · imported {{ ago(status.data.value.game.importedAt) }} ago</span>
              </template>
              <span v-else class="tag err">No import</span>
            </dd>
          </dl>

          <div class="block">
            <span class="panel-title">UEX pull</span>
            <div v-if="!status.data.value.uex.length" class="line"><span class="tag warn">No data</span> <span class="faint">the ext process has not pulled yet</span></div>
            <table v-else class="mini">
              <thead><tr><th>State</th><th>Endpoint</th><th class="num">Rows</th><th>Last checked</th><th>Last changed</th></tr></thead>
              <tbody>
                <tr v-for="e in status.data.value.uex" :key="e.endpoint">
                  <td><span class="tag" :class="e.state">{{ STATE[e.state] }}</span></td>
                  <td class="mono">{{ e.endpoint }}</td>
                  <td class="num mono">{{ e.rows.toLocaleString() }}</td>
                  <td>{{ ago(e.checkedAt) }} ago</td>
                  <td class="dim">{{ dateTime(e.changedAt) }}</td>
                </tr>
              </tbody>
            </table>
          </div>

          <div class="block">
            <span class="panel-title">Bot logs channels</span>
            <div v-if="!status.data.value.botLogs.length" class="faint line">No org has a logs channel</div>
            <table v-else class="mini">
              <thead><tr><th>State</th><th>Org</th><th>Level</th><th class="num">Waiting</th><th>Oldest waiting</th></tr></thead>
              <tbody>
                <tr v-for="g in status.data.value.botLogs" :key="g.guildId" class="link" @click="router.push(`/orgs/${g.guildId}`)">
                  <td><span class="tag" :class="g.state">{{ g.marked ? (g.state === "ok" ? "Working" : g.state === "warn" ? "Behind" : "Stuck") : "No mark" }}</span></td>
                  <td>{{ g.org }}</td>
                  <td class="mono dim">{{ g.level }}</td>
                  <td class="num mono" :class="{ faint: !g.pending }">{{ g.pending >= 100 ? "100+" : g.pending }}</td>
                  <td :class="{ faint: !g.oldestPendingAt }">{{ g.oldestPendingAt ? `${ago(g.oldestPendingAt)} ago` : "—" }}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
        <div v-else class="empty-line">Loading…</div>
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
              <thead><tr><th>User</th><th>Subject</th><th>Location</th><th class="num">Amount</th></tr></thead>
              <tbody>
                <tr v-for="(h, i) in c.hits" :key="i" class="link" @click="router.push(`/users/${h.userId}`)">
                  <td><span v-if="h.name">{{ h.name }}</span><span v-else class="mono faint">{{ h.userId }}</span></td>
                  <td>{{ h.subject }}</td>
                  <td class="dim">{{ h.location ?? "" }}</td>
                  <td class="num mono">{{ h.amount ? `${h.amount} ${h.unit}` : "" }}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
        <div v-else class="empty-line">Loading…</div>
      </section>

      <section class="panel">
        <div class="head">
          <Icon name="blueprint" :size="16" />
          <span class="head-title no-grow">Catalog</span>
          <HelpTip :text="HELP.gaps" />
        </div>
        <div v-if="overview.error.value" class="empty-line">{{ overview.error.value }}</div>
        <template v-else-if="overview.data.value">
          <div class="tiles">
            <template v-for="c in overview.data.value.counts" :key="c.entity">
              <button v-if="MAIN[c.entity]" type="button" class="tile" @click="router.push(MAIN[c.entity]!.to)">
                <span class="inline"><span class="panel-title">{{ MAIN[c.entity]!.label }}</span> <HelpTip :text="MAIN[c.entity]!.help" /></span>
                <span class="tile-value">{{ c.active.toLocaleString() }}</span>
                <span v-if="c.retired" class="faint inline">{{ c.retired }} retired <HelpTip :text="HELP.retired" /></span>
              </button>
            </template>
          </div>
          <div class="minor">
            <template v-for="c in overview.data.value.counts" :key="c.entity">
              <span v-if="MINOR[c.entity]" class="inline">
                {{ c.active.toLocaleString() }} {{ MINOR[c.entity]!.label }} <HelpTip :text="MINOR[c.entity]!.help" />
              </span>
            </template>
          </div>
          <div class="pad columns">
            <table class="mini grow">
              <thead>
                <tr><th>Without text</th><th class="num">in <span class="mono">{{ overview.data.value.gaps.lang }}</span></th><th class="num">anywhere</th><th class="num">of</th></tr>
              </thead>
              <tbody>
                <tr v-for="t in overview.data.value.gaps.texts" :key="t.entity">
                  <td>{{ TEXT_ENTITIES[t.entity] ?? t.entity }}</td>
                  <td class="num mono" :class="{ faint: !t.missingInLang }">{{ t.missingInLang }}</td>
                  <td class="num mono" :class="{ faint: !t.missingEverywhere }">{{ t.missingEverywhere }}</td>
                  <td class="num mono faint">{{ t.total }}</td>
                </tr>
              </tbody>
            </table>
            <dl class="kv grow">
              <dt>Without a known source <HelpTip :text="HELP.noSource" /></dt>
              <dd>{{ overview.data.value.gaps.noSourceBlueprints }}</dd>
              <dt>Unknown registered by users <HelpTip :text="HELP.registeredNoSource" /></dt>
              <dd :class="{ faint: !overview.data.value.gaps.registeredNoSource.length }">
                <template v-if="!overview.data.value.gaps.registeredNoSource.length">0</template>
                <template v-for="(b, i) in overview.data.value.gaps.registeredNoSource" :key="b.uuid">
                  <template v-if="i">, </template>
                  <RouterLink :to="`/blueprints/${b.uuid}`">{{ b.name }}</RouterLink> <span class="faint">({{ b.users }})</span>
                </template>
              </dd>
              <dt>Without output</dt>
              <dd :class="{ faint: !overview.data.value.gaps.noOutputBlueprints }">{{ overview.data.value.gaps.noOutputBlueprints }}</dd>
            </dl>
          </div>
        </template>
        <div v-else class="empty-line">Loading…</div>
      </section>

      <section class="panel">
        <div class="head">
          <Icon name="list-large" :size="16" />
          <span class="head-title no-grow">Thumbnails</span>
        </div>
        <div v-if="thumbs.error.value" class="empty-line">{{ thumbs.error.value }}</div>
        <div v-else-if="thumbs.data.value" class="pad">
          <dl class="kv">
            <dt>Rendered</dt>
            <dd>{{ thumbs.data.value.count.toLocaleString() }} <span class="faint">of {{ thumbs.data.value.targets.toLocaleString() }} items and materials</span></dd>
            <dt>Manifest</dt>
            <dd :class="{ faint: !thumbs.data.value.updatedAt }">
              <template v-if="thumbs.data.value.updatedAt">{{ dateTime(thumbs.data.value.updatedAt) }} <span class="faint">({{ ago(thumbs.data.value.updatedAt) }})</span></template>
              <template v-else>none</template>
            </dd>
            <dt>Without one</dt>
            <dd :class="{ faint: !thumbs.data.value.missing.length }">
              <template v-if="!thumbs.data.value.missing.length">0</template>
              <template v-else>
                <button type="button" class="missing-toggle" :aria-expanded="missingOpen" @click="missingOpen = !missingOpen">
                  <Icon :name="missingOpen ? 'chevron-down' : 'chevron-right'" :size="14" />
                  {{ thumbs.data.value.missing.length.toLocaleString() }}
                </button>
                <ul v-if="missingOpen" class="missing-list">
                  <li v-for="m in thumbs.data.value.missing" :key="m.uuid">
                    <RouterLink :to="m.kind === 'item' ? `/items/${m.uuid}` : `/materials/${m.uuid}`">{{ m.name }}</RouterLink>
                    <span class="faint mono">{{ m.type ?? "material" }}</span>
                  </li>
                </ul>
              </template>
            </dd>
          </dl>
        </div>
        <div v-else class="empty-line">Loading…</div>
      </section>
    </div>
  </div>
</template>

<style scoped>
/* The thumbnails' missing list: closed, the whole line toggles; open, five rows high, then it scrolls */
.missing-toggle {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  padding: 0;
  border: none;
  background: none;
  color: inherit;
  font: inherit;
  cursor: pointer;
}

.missing-list {
  margin: 6px 0 0;
  padding: 0;
  list-style: none;
  max-height: calc(5 * 22px);
  overflow: auto;
}

.missing-list li {
  display: flex;
  gap: 8px;
  height: 22px;
  align-items: center;
  white-space: nowrap;
}

.scroll {
  overflow: auto;
}

.scroll > .panel {
  flex-shrink: 0;
}

.pad {
  padding: 12px 16px 14px;
}

.services {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.block {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.line {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
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
  font-size: 13px;
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
  padding: 0 16px 4px;
  font-size: 12px;
  color: var(--text-2);
}

.columns {
  display: flex;
  gap: 24px;
  align-items: flex-start;
}

.grow {
  flex: 1;
  min-width: 0;
}
</style>
