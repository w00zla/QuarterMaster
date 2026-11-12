// The side panel's widths and the pure decisions of SideTabs.vue (tested in test/companion-sidetabs.test.ts). The window's minimum
// width with the narrow panel (tauri.conf.json) is the tables' former 640 px plus the panel; with the wide panel the minimum grows
// by the difference, so the tables keep that width in both modes.

export type SideMode = "wide" | "narrow";

export const SIDE_NARROW = 56;
export const SIDE_WIDE = 200;
/** The window's minimum (and default) width with the narrow panel: 640 px for the tables plus the panel (also in tauri.conf.json). */
export const WINDOW_MIN = 640 + SIDE_NARROW;
/** The window's minimum width with the wide panel. */
export const WINDOW_MIN_WIDE = WINDOW_MIN - SIDE_NARROW + SIDE_WIDE;

/** The stored choice; anything else is narrow. */
export const parseSideMode = (stored: string | null): SideMode => (stored === "wide" ? "wide" : "narrow");

/** The window's minimum width in a mode. */
export const minWidthFor = (mode: SideMode): number => (mode === "wide" ? WINDOW_MIN_WIDE : WINDOW_MIN);
