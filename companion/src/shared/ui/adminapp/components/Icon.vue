<script lang="ts">
// SVG inner markup only (paths/shapes on a 24x24 grid, stroke-based, one
// consistent style).
export const ICONS = {
  // From BindSight's icon set (stroke-based, 24x24); the others follow the same style.
  close: '<path d="M6 6l12 12M18 6 6 18"/>',
  'chevron-down': '<path d="m6 9 6 6 6-6"/>',
  'chevron-up': '<path d="m6 15 6-6 6 6"/>',
  'chevron-right': '<path d="m9 6 6 6-6 6"/>',
  list: '<path d="M8 6h13M8 12h13M8 18h13"/><path d="M3 6h.01M3 12h.01M3 18h.01"/>',
  'list-large': '<rect x="3" y="4" width="7" height="7" rx="1"/><rect x="3" y="13" width="7" height="7" rx="1"/><path d="M14 7.5h7M14 16.5h7"/>',
  log: '<path d="M4 4h16v16H4z"/><path d="M8 9h8M8 13h6"/>',
  warning: '<path d="M12 3 2 21h20L12 3z"/><path d="M12 10v5M12 18v.5"/>',
  file: '<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l4 2"/>',
  check: '<path d="m5 12 5 5L20 7"/>',
  history: '<path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 4v5h5"/><path d="M12 8v4l3 2"/>',
  eye: '<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/>',
  'eye-off': '<path d="M10.6 6.2A9.9 9.9 0 0 1 12 6c6.4 0 10 7 10 7a17 17 0 0 1-3 3.8"/><path d="M6.6 7.6A17 17 0 0 0 2 13s3.6 7 10 7a9.8 9.8 0 0 0 4.5-1.1"/><path d="M9.9 10.9a3 3 0 0 0 4.2 4.2"/><path d="M3 3l18 18"/>',
  refresh: '<path d="M21 12a9 9 0 1 1-3-6.7"/><path d="M21 3v6h-6"/>',
  link: '<path d="M9 17H7a5 5 0 0 1 0-10h2"/><path d="M15 7h2a5 5 0 1 1 0 10h-2"/><path d="M8 12h8"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
  trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>',
  imports: '<path d="M12 3v12M7 10l5 5 5-5"/><path d="M4 21h16"/>',
  drop: '<path d="M12 3s6 7 6 11a6 6 0 0 1-12 0c0-4 6-11 6-11z"/>',
  minimize: '<path d="M5 12h14"/>',
  maximize: '<rect x="5" y="5" width="14" height="14" rx="1"/>',
  restore: '<rect x="4" y="8" width="12" height="12" rx="1"/><path d="M8 8V5a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1h-3"/>',
  desktop: '<rect x="3" y="4" width="18" height="12" rx="1"/><path d="M8 20h8M12 16v4"/>',
  lock: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
  external: '<path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
  // Stock kinds and tabs: blueprints, resources, items, ship components, FPS gear, stored crates
  blueprint: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M9 21V9"/><path d="M13 13h4M13 17h4"/>',
  resource: '<path d="M6 3h12l3 6-9 12L3 9z"/><path d="M3 9h18M12 21 8 9l4-6 4 6z"/>',
  item: '<path d="M21 8 12 3 3 8v8l9 5 9-5z"/><path d="m3 8 9 5 9-5M12 13v8"/>',
  gear: '<rect x="3" y="8" width="18" height="12" rx="2"/><path d="M9 8V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v3"/><path d="M3 13h18"/><path d="M10 13v2h4v-2"/>',
  'type-module': '<rect x="6" y="6" width="12" height="12" rx="2"/><path d="M10 10h4v4h-4zM9 2v4M15 2v4M9 18v4M15 18v4M2 9h4M2 15h4M18 9h4M18 15h4"/>',
  'type-personal-weapon': '<path d="M2 10h17l3-2v4h-6l-1 2h-4l-1 4H6l1-4H2z"/>',
  'type-crate': '<rect x="3" y="6" width="18" height="14" rx="1"/><path d="M3 10h18M8 6v14M16 6v14"/>',
  // A crosshair: the location detected automatically
  locate: '<circle cx="12" cy="12" r="7"/><circle cx="12" cy="12" r="2"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/>',
  // A funnel: the user's own scan filters
  filter: '<path d="M3 5h18l-7 8v6l-4 2v-8z"/>',
} as const

export type IconName = keyof typeof ICONS
</script>

<script setup lang="ts">
withDefaults(defineProps<{ name: IconName; size?: number; fill?: string }>(), {
  size: 16,
  fill: 'none',
})
</script>

<template>
  <!-- v-html renders ICONS[name], a constant defined above -- never user input -->
  <svg
    :width="size"
    :height="size"
    viewBox="0 0 24 24"
    :fill="fill"
    stroke="currentColor"
    stroke-width="2"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
    v-html="ICONS[name]"
  />
</template>
