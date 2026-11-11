// The side panel's widths and the pure decisions of SideTabs.vue (tested in test/companion-sidetabs.test.ts). The window's minimum
// width (tauri.conf.json) is the tables' former 640 px plus the narrow panel; the wide panel is allowed once the tables keep that
// width with it too. Like the web app's side bar (webapp/src/navigation.ts), but with these thresholds.

export type SideMode = "wide" | "narrow";

export const SIDE_NARROW = 56;
export const SIDE_WIDE = 200;
/** The window's minimum (and default) width: 640 px for the tables plus the narrow panel (also in tauri.conf.json). */
export const WINDOW_MIN = 640 + SIDE_NARROW;
/** From this window width on the panel may be wide. */
export const SIDE_WIDE_FROM = WINDOW_MIN - SIDE_NARROW + SIDE_WIDE;

/** The stored choice; anything else is narrow. */
export const parseSideMode = (stored: string | null): SideMode => (stored === "wide" ? "wide" : "narrow");

/** The mode in effect for a window width (below SIDE_WIDE_FROM the panel is narrow whatever the choice). */
export const sideModeFor = (choice: SideMode, windowWidth: number): SideMode => (windowWidth < SIDE_WIDE_FROM ? "narrow" : choice);
