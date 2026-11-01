<script lang="ts">
// SVG inner markup only (paths/shapes on a 24x24 grid, stroke-based, one
// consistent style).
export const ICONS = {
  // Taken from BindSight's icon set (stroke-based, 24x24); the catalog icons at the end follow the same style.
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/>',
  close: '<path d="M6 6l12 12M18 6 6 18"/>',
  'chevron-down': '<path d="m6 9 6 6 6-6"/>',
  'chevron-up': '<path d="m6 15 6-6 6 6"/>',
  'chevron-right': '<path d="m9 6 6 6-6 6"/>',
  'chevron-left': '<path d="m15 6-6 6 6 6"/>',
  list: '<path d="M8 6h13M8 12h13M8 18h13"/><path d="M3 6h.01M3 12h.01M3 18h.01"/>',
  // The larger list view: two tall rows, each a picture and its line
  'list-large': '<rect x="3" y="4" width="7" height="7" rx="1"/><rect x="3" y="13" width="7" height="7" rx="1"/><path d="M14 7.5h7M14 16.5h7"/>',
  log: '<path d="M4 4h16v16H4z"/><path d="M8 9h8M8 13h6"/>',
  warning: '<path d="M12 3 2 21h20L12 3z"/><path d="M12 10v5M12 18v.5"/>',
  copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a1 1 0 0 1 1-1h10"/>',
  file: '<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l4 2"/>',
  check: '<path d="m5 12 5 5L20 7"/>',
  history: '<path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 4v5h5"/><path d="M12 8v4l3 2"/>',
  eye: '<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/>',
  camera: '<path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/>',
  'eye-off': '<path d="M10.6 6.2A9.9 9.9 0 0 1 12 6c6.4 0 10 7 10 7a17 17 0 0 1-3 3.8"/><path d="M6.6 7.6A17 17 0 0 0 2 13s3.6 7 10 7a9.8 9.8 0 0 0 4.5-1.1"/><path d="M9.9 10.9a3 3 0 0 0 4.2 4.2"/><path d="M3 3l18 18"/>',
  refresh: '<path d="M21 12a9 9 0 1 1-3-6.7"/><path d="M21 3v6h-6"/>',
  link: '<path d="M9 17H7a5 5 0 0 1 0-10h2"/><path d="M15 7h2a5 5 0 1 1 0 10h-2"/><path d="M8 12h8"/>',
  'arrow-left': '<path d="M19 12H5"/><path d="m11 18-6-6 6-6"/>',
  'arrow-right': '<path d="M4 12h14M13 6l6 6-6 6"/>',
  'arrow-up': '<path d="M12 20V6M6 11l6-6 6 6"/>',
  move: '<path d="M12 3v18M3 12h18"/><path d="m9 6 3-3 3 3M9 18l3 3 3-3M6 9l-3 3 3 3M18 9l3 3-3 3"/>',
  split: '<path d="M12 21v-7"/><path d="M12 14 6 6"/><path d="m12 14 6-8"/><path d="M6 10V6h4"/><path d="M18 10V6h-4"/>',
  merge: '<path d="M12 3v7"/><path d="M12 10 6 18"/><path d="m12 10 6 8"/><path d="M9 6l3-3 3 3"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
  trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  minus: '<path d="M5 12h14"/>',
  // A hammer: crafting
  crafter: '<path d="m4 20 10.5-10.5"/><path d="m11.5 6.5 4-4 6 6-4 4z"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>',
  overview: '<rect x="3" y="3" width="7" height="9" rx="1"/><rect x="14" y="3" width="7" height="5" rx="1"/><rect x="14" y="12" width="7" height="9" rx="1"/><rect x="3" y="16" width="7" height="5" rx="1"/>',
  blueprint: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M9 21V9"/><path d="M13 13h4M13 17h4"/>',
  resource: '<path d="M6 3h12l3 6-9 12L3 9z"/><path d="M3 9h18M12 21 8 9l4-6 4 6z"/>',
  item: '<path d="M21 8 12 3 3 8v8l9 5 9-5z"/><path d="m3 8 9 5 9-5M12 13v8"/>',
  gear: '<rect x="3" y="8" width="18" height="12" rx="2"/><path d="M9 8V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v3"/><path d="M3 13h18"/><path d="M10 13v2h4v-2"/>',
  texts: '<path d="M4 5h8M8 3v2M5 11c2.5 0 5-2.7 5-6"/><path d="M6 8c1 1.8 2.7 3 5 3"/><path d="m12 21 4-9 4 9M13.5 18h5"/>',
  imports: '<path d="M12 3v12M7 10l5 5 5-5"/><path d="M4 21h16"/>',
  // Admin navigation: activity (a pulse), status (a gauge), stock (stacked boxes), the bot, the sidebar toggle
  activity: '<path d="M3 12h4l3-8 4 16 3-8h4"/>',
  status: '<path d="M4 18a8 8 0 1 1 16 0"/><path d="m12 18 4-6"/>',
  stock: '<rect x="3" y="12" width="8" height="8" rx="1"/><rect x="13" y="12" width="8" height="8" rx="1"/><rect x="8" y="3" width="8" height="8" rx="1"/>',
  bot: '<rect x="4" y="8" width="16" height="12" rx="3"/><path d="M12 4v4M9 13v2M15 13v2"/>',
  sidebar: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16"/>',
  // Item types
  'type-helmet': '<path d="M4 15a8 8 0 0 1 16 0v4H4z"/><path d="M8 15h8"/>',
  'type-torso': '<path d="M8 3 4 6v6l2 1v8h12v-8l2-1V6l-4-3"/><path d="M8 3a4 4 0 0 0 8 0"/>',
  'type-arms': '<path d="M8 21v-6l-3-4V7a1.5 1.5 0 0 1 3 0v3"/><path d="M8 10V5a1.5 1.5 0 0 1 3 0v5"/><path d="M11 10V4.5a1.5 1.5 0 0 1 3 0V10"/><path d="M14 10V6a1.5 1.5 0 0 1 3 0v6l-2 3v6"/>',
  'type-legs': '<path d="M7 3h10l-1 18h-3l-1-11-1 11H8z"/>',
  'type-backpack': '<rect x="5" y="7" width="14" height="14" rx="3"/><path d="M9 7V5a3 3 0 0 1 6 0v2"/><path d="M9 14h6"/>',
  'type-undersuit': '<path d="M9 3h6l3 4-2 2v12h-3l-1-8-1 8H8V9L6 7z"/>',
  'type-shirt': '<path d="M8 4 3 7l2 4 2-1v10h10V10l2 1 2-4-5-3a4 4 0 0 1-8 0z"/>',
  'type-footwear': '<path d="M5 4h5v8l9 3v4H5z"/><path d="M5 15h14"/>',
  'type-cooler': '<path d="M12 2v20M4.9 7l14.2 10M4.9 17 19.1 7"/><path d="m9 4 3 2 3-2M9 20l3-2 3 2"/>',
  'type-power': '<path d="M13 2 4 14h7l-1 8 9-12h-7z"/>',
  'type-shield': '<path d="M12 3 4 6v6c0 5 3.5 8 8 9 4.5-1 8-4 8-9V6z"/>',
  'type-quantum': '<path d="M12 12c-2-2.7-3.6-4-5.5-4a4 4 0 0 0 0 8c1.9 0 3.5-1.3 5.5-4zm0 0c2 2.7 3.6 4 5.5 4a4 4 0 0 0 0-8c-1.9 0-3.5 1.3-5.5 4z"/>',
  'type-radar': '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><path d="m12 12 6-6"/>',
  'type-gun': '<path d="M2 10h14v4H2z"/><path d="M16 11h6M16 13h6"/><path d="m6 14-1 6h6l-1-6"/>',
  'type-personal-weapon': '<path d="M2 10h17l3-2v4h-6l-1 2h-4l-1 4H6l1-4H2z"/>',
  'type-attachment': '<rect x="4" y="9" width="14" height="5" rx="2"/><path d="M18 10h3v3h-3M7 14v3M15 14v3"/>',
  'type-mining-laser': '<path d="m3 21 6-6"/><path d="m8 13 3 3 7-7-3-3z"/><path d="M19 2v3M22 5h-3"/>',
  'type-module': '<rect x="6" y="6" width="12" height="12" rx="2"/><path d="M10 10h4v4h-4zM9 2v4M15 2v4M9 18v4M15 18v4M2 9h4M2 15h4M18 9h4M18 15h4"/>',
  'type-salvage': '<path d="M3 12h6"/><path d="M9 8h4l3 4-3 4H9z"/><path d="M16 12h5M18 8l3-2M18 16l3 2"/>',
  'type-tractor': '<path d="M6 4v8a6 6 0 0 0 12 0V4h-4v8a2 2 0 0 1-4 0V4z"/><path d="M6 8h4M14 8h4"/>',
  'type-docking': '<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2"/>',
  'type-crate': '<rect x="3" y="6" width="18" height="14" rx="1"/><path d="M3 10h18M8 6v14M16 6v14"/>',
  // For the user web app (edit, drop, bolt from BindSight)
  edit: '<path d="M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16z"/><path d="m13.5 6.5 4 4"/>',
  drop: '<path d="M12 3s6 7 6 11a6 6 0 0 1-12 0c0-4 6-11 6-11z"/>',
  bolt: '<path d="M13 2 4 14h7l-1 8 9-12h-7z"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
  users: '<circle cx="9" cy="8" r="3.5"/><path d="M2 20a7 7 0 0 1 14 0"/><path d="M16 4.5a3.5 3.5 0 0 1 0 7M18 13.5a7 7 0 0 1 4 6.5"/>',
  'log-out': '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="m16 17 5-5-5-5"/><path d="M21 12H9"/>',
  minimize: '<path d="M5 12h14"/>',
  maximize: '<rect x="5" y="5" width="14" height="14" rx="1"/>',
  restore: '<rect x="4" y="8" width="12" height="12" rx="1"/><path d="M8 8V5a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1h-3"/>',
  desktop: '<rect x="3" y="4" width="18" height="12" rx="1"/><path d="M8 20h8M12 16v4"/>',
  lock: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
  external: '<path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>',
  // For the companion: a crosshair, the location detected automatically
  locate: '<circle cx="12" cy="12" r="7"/><circle cx="12" cy="12" r="2"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/>',
  // For the user web app's mining: a pickaxe
  pickaxe: '<path d="M3 21 13.5 10.5"/><path d="M7.5 5.5c4-2.5 8.5-1.5 10.5.5s3 6.5.5 10.5"/><path d="m11 8 5 5"/>',
  // For the user web app's trading: two opposed arrows (buy and sell)
  trade: '<path d="M7 4 3 8l4 4"/><path d="M3 8h14"/><path d="m17 12 4 4-4 4"/><path d="M21 16H7"/>',
  // The mining dialog's target quality
  target: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1.5"/>',
  // For the companion: a funnel, the user's own scan filters
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
