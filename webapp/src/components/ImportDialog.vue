<script setup lang="ts">
// "Import file": the game data pack from a file on this machine (the start tile and the settings view). A path field, and
// the file picker where the desktop shell has one.
import { computed, ref } from "vue";
import { importData } from "../local";
import { t } from "../i18n";
import { shell } from "../shell";
import { toastError } from "../toasts";
import ConfirmDialog, { type ConfirmButton } from "./ConfirmDialog.vue";
import Icon from "../../../adminapp/src/components/Icon.vue";

const emit = defineEmits<{ close: [] }>();

const path = ref("");
const busy = ref(false);

const buttons = computed<ConfirmButton[]>(() => [
  { label: t("common.cancel"), kind: "outline", value: "cancel" },
  { label: t("data.import"), kind: "primary", value: "import", icon: "imports", form: "import-file", disabled: path.value.trim() === "" || busy.value },
]);

async function pick() {
  const file = await shell.pickFile(["zip"]);
  if (file) path.value = file;
}

async function submit() {
  const file = path.value.trim();
  if (!file || busy.value) return;
  busy.value = true;
  try {
    await importData(file);
    emit("close");
  } catch (e) {
    toastError(e);
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <ConfirmDialog :title="t('data.import')" icon="imports" :buttons="buttons" @choose="emit('close')">
    <form id="import-file" class="form single flush" @submit.prevent="submit">
      <div class="field">
        <label for="import-path">{{ t("data.file") }}</label>
        <span class="path-row">
          <input id="import-path" v-model="path" class="input mono" type="text" autocomplete="off" spellcheck="false" autofocus />
          <button v-if="shell.available" class="btn outline" type="button" @click="pick">
            <Icon name="folder" :size="14" /> {{ t("folder.browse") }}
          </button>
        </span>
      </div>
    </form>
  </ConfirmDialog>
</template>

<style scoped>
.path-row {
  display: flex;
  align-items: center;
  gap: 8px;
}
</style>
