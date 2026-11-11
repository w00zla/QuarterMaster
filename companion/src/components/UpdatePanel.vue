<script setup lang="ts">
// Shown instead of everything else while the server refuses this app's API contract number: which side is too old
// (this companion: 426; the server or the local app: 409), the installed version and, for an outdated companion,
// the one button that opens the releases page on GitHub in the browser. The app installs nothing itself.
import { computed } from "vue";
import Icon from "../../../adminapp/src/components/Icon.vue";
import { openReleases } from "../backend";
import { outdatedKeys, type Connection, type Outdated } from "../connection";
import { t } from "../i18n";
import { toastError } from "../toasts";

const props = defineProps<{ outdated: Outdated; current: string; connection: Connection }>();

const keys = computed(() => outdatedKeys(props.outdated, props.connection));
</script>

<template>
  <section class="panel update">
    <div class="head">
      <Icon name="warning" :size="16" />
      <span class="head-title">{{ t(keys.title) }}</span>
    </div>
    <div class="body">
      <span>{{ t(keys.text) }}</span>
      <div class="versions">
        <span class="key">{{ t("outdated.installed") }}</span>
        <span class="mono">{{ current }}</span>
      </div>
      <button v-if="outdated.side === 'companion'" type="button" class="btn primary" @click="openReleases().catch(toastError)">
        <Icon name="external" :size="14" /> {{ t("outdated.releases") }}
      </button>
    </div>
  </section>
</template>

<style scoped>
.update {
  max-width: 440px;
  width: 100%;
  margin: 48px auto 0;
}

.body {
  display: flex;
  flex-direction: column;
  gap: 16px;
  padding: 16px;
  font-size: 13px;
}

.versions {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 6px 16px;
}

.key {
  color: var(--text-2);
}

.btn {
  align-self: flex-start;
}
</style>
