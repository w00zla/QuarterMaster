<script setup lang="ts">
// Schaltet die Listenansicht einer Tabelle um: Kompakt (kleines Thumbnail neben dem Namen) oder Thumbnails
// (höhere Zeilen, Thumbnail-Spalte vorn); gespeichert mit den Spalten der Tabelle (tableColumns.ts `view`).
// Neben dem ColumnsButton; geteilt von Web-App und Companion, die Texte kommen herein.
import Icon from "../../adminapp/components/Icon.vue";
import Tooltip from "../../adminapp/components/Tooltip.vue";
import type { useTableColumns } from "../../adminapp/tableColumns";

export interface ViewTexts {
  // Tooltip: was ein Klick einschaltet
  toThumbs: string;
  toCompact: string;
}

// `size`: Kantenlänge des Buttons in px, wie beim ColumnsButton
const props = withDefaults(defineProps<{ table: ReturnType<typeof useTableColumns>; texts: ViewTexts; size?: number }>(), { size: 16 });
</script>

<template>
  <Tooltip :text="table.view.value === 'compact' ? texts.toThumbs : texts.toCompact">
    <button
      type="button"
      class="icon-btn view-btn"
      :style="{ width: `${props.size}px`, height: `${props.size}px` }"
      :aria-pressed="table.view.value === 'thumbs'"
      @click.stop="table.toggleView()"
    >
      <Icon :name="table.view.value === 'compact' ? 'list-large' : 'list'" :size="props.size - 5" />
    </button>
  </Tooltip>
</template>
