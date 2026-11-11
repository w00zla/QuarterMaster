<script setup lang="ts">
// The scan row below the title bar: the Scan toggle (off = outline, on = accent with a pulsing dot,
// locked while the overlay runs it), the overlay toggle (Windows), one tag that always says what the
// scan does (scan.ts scanState), the "Loading…" tag while an API call takes a while (state.ts
// loadingTexts); on the right the game log's problem (a chip only then, opens the settings: the
// blueprints and the auto location need the log), the auto location toggle and the location picker
// (where warehouse and inventory reads are booked; kept, changeable while scanning).
import { computed } from "vue";
import Icon from "../../../adminapp/src/components/Icon.vue";
import Tooltip from "../../../adminapp/src/components/Tooltip.vue";
import Picker from "../../../webapp/src/components/Picker.vue";
import { t } from "../i18n";
import { autoLocation, locationUuid, loggedLocation, loggedLocationUuid, setLocation, toggleAutoLocation } from "../inventorySync";
import { overlayOn, setOverlay } from "../overlay";
import { syncCatalog } from "../refinerySync";
import { scanOn, scanState, setScanOn } from "../scan";
import { connected, loadingTexts, log } from "../state";

const emit = defineEmits<{ settings: [] }>();

const isWindows = navigator.userAgent.includes("Windows");
// Connected, but the catalog is not there yet (thin line): picker and Scan wait for it
const catalogPending = computed(() => connected.value && !syncCatalog.value);
const locationOptions = computed(() => (syncCatalog.value?.locations ?? []).map((l) => ({ value: l.uuid, label: l.short })));
const locationName = (uuid: string) => syncCatalog.value?.locations.find((l) => l.uuid === uuid)?.short ?? "?";

const scanTip = computed(() =>
  overlayOn.value ? t("overlay.controls") : !connected.value ? t("conn.off") : catalogPending.value ? t("load.catalogPending") : t(scanOn.value ? "scan.stopTip" : "scan.startTip"),
);
// The auto toggle's tooltip: what it does, or while on what Game.log named last
const autoTip = computed(() => {
  if (!autoLocation.value) return t("inventory.autoLocation");
  if (!loggedLocation.value) return t("inventory.autoLocationNone");
  return loggedLocationUuid.value
    ? t("inventory.autoLocationOn", { name: locationName(loggedLocationUuid.value) })
    : t("inventory.autoLocationOther", { key: loggedLocation.value });
});
// The picked location's full name (the field clips it), else what it is for
const locationTip = computed(() =>
  locationUuid.value ? (syncCatalog.value?.locations.find((l) => l.uuid === locationUuid.value)?.label ?? null) : t("scan.locationTip"),
);
const logTip = computed(() => (log.value ? t("log.notFound", { path: log.value.path }) : null));
</script>

<template>
  <div class="scanbar">
    <Tooltip :text="scanTip">
      <button
        type="button" class="btn small outline scan-btn" :class="{ on: scanOn }" :aria-pressed="scanOn"
        :disabled="overlayOn || !connected || catalogPending" @click="setScanOn(!scanOn)"
      >
        <span class="state-icon">
          <Icon v-if="overlayOn" name="lock" :size="12" />
          <span v-else-if="scanOn" class="pulse" />
          <Icon v-else name="eye" :size="14" />
        </span>
        {{ t("scan.start") }}
      </button>
    </Tooltip>
    <Tooltip v-if="isWindows" :text="t(overlayOn ? 'overlay.hide' : 'overlay.show')">
      <button type="button" class="icon-btn toggle" :class="{ active: overlayOn }" :aria-pressed="overlayOn" @click="setOverlay(!overlayOn)">
        <Icon name="desktop" :size="14" />
      </button>
    </Tooltip>
    <span class="tag state" :class="scanState.cls"><Icon :name="scanState.icon" :size="12" /> {{ scanState.text }}</span>
    <!-- Calls that take a while (thin line): what is loading in the tooltip -->
    <Tooltip v-if="loadingTexts.length" :text="loadingTexts.join(' · ')">
      <span class="tag spinning"><Icon name="refresh" :size="12" /> {{ t("load.tag") }}</span>
    </Tooltip>
    <div class="spacer" />
    <Tooltip v-if="log && !log.found" :text="logTip">
      <button type="button" class="tag warn problem" @click="emit('settings')">
        <Icon name="warning" :size="12" /> {{ t("log.missing") }}
      </button>
    </Tooltip>
    <Tooltip :text="autoTip">
      <button type="button" class="icon-btn toggle auto" :class="{ active: autoLocation }" :aria-pressed="autoLocation" @click="toggleAutoLocation">
        <Icon name="locate" :size="13" />
      </button>
    </Tooltip>
    <span class="location">
      <Tooltip :text="locationTip">
        <Picker
          :model-value="locationUuid" :options="locationOptions" :disabled="catalogPending"
          :placeholder="t(catalogPending ? 'load.catalogPending' : 'inventory.location')" @update:model-value="setLocation"
        />
      </Tooltip>
    </span>
  </div>
</template>

<style scoped>
/* Fixed height whatever it holds */
.scanbar {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 48px;
  flex-shrink: 0;
  padding: 0 16px;
  background: var(--bg-surface);
  border-bottom: 1px solid var(--border-dim);
}

.spacer {
  flex: 1;
}

/* On: accent frame and backdrop, a pulsing dot instead of the eye */
.scan-btn.on {
  border-color: var(--accent);
  background: color-mix(in srgb, var(--accent) 12%, transparent);
  color: var(--accent);
}

/* Locked by the overlay: still visibly on, not dimmed like a disabled button */
.scan-btn.on:disabled {
  opacity: 1;
  border-color: color-mix(in srgb, var(--accent) 50%, transparent);
}

/* The state's icon (lock, dot, eye) in one fixed place: the button keeps its width */
.state-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 14px;
  height: 14px;
}

.pulse {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: currentColor;
  animation: pulse 1.6s ease-in-out infinite;
}

@keyframes pulse {
  50% {
    opacity: 0.25;
  }
}

/* The toggles (overlay, auto location): off = dashed and dimmed, on = accent with a faint backdrop */
.toggle {
  width: 26px;
  height: 26px;
  border-style: dashed;
  color: var(--text-3);
}

.toggle.active {
  border-style: solid;
  background: color-mix(in srgb, var(--accent) 12%, transparent);
  color: var(--accent);
}

.toggle.auto {
  width: 20px;
  height: 20px;
}

/* The state tag clips a long text instead of pushing the picker out */
.state {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* Problems (game log missing): a tag, but a button (opens the settings) */
.problem {
  border: none;
  font-family: inherit;
  cursor: pointer;
}

/* A fixed width: the state and loading tags to the left change their width without moving it (the
   state tag clips when room runs out) */
.location {
  flex: none;
  width: 240px;
}

/* The tooltip's anchor and the picker fill the place */
.location :deep(.tip-anchor),
.location :deep(.tip-anchor) > * {
  display: block;
  width: 100%;
}

/* The loading tag: the icon turns */
.spinning svg {
  animation: spin 1s linear infinite;
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}
</style>
