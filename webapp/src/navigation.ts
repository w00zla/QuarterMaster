// What the UI derives from a server's capabilities: the traits the views ask (`traitsOf`: local app, one user, side layout) and
// which navigation the top bar, the side bar and the router offer (pure: tested in test/webapp-local.test.ts).
// (No imports of Vue files or i18n: the root type check and the tests load this file; `label` and `icon` are literal
// strings that the top bar checks against the text keys and the icon map.)

export interface NavItem {
  to: string;
  label: "nav.home" | "nav.components" | "nav.stock" | "nav.refinery" | "nav.blueprints" | "nav.crafting" | "nav.mining" | "nav.trade" | "nav.history";
  icon: "overview" | "gear" | "type-crate" | "drop" | "blueprint" | "crafter" | "pickaxe" | "trade" | "history";
  /** Drawn quieter than the main entries (the side bar's history). */
  secondary?: boolean;
  /** Shown but not usable (the side bar's buy/sell entry without UEX data). */
  disabled?: boolean;
}

/** What the navigation needs of GET /api/capabilities. */
export interface NavCaps {
  login: "discord" | "none";
  orgs: boolean;
  uex: boolean;
}

/**
 * What the views ask instead of the capabilities themselves: each property is named for what it means, so a view never
 * tests "no login" when it means something else. Today all three follow from `login: "none"` (the singleuser variant);
 * a variant that differs in one of them changes this function only.
 */
export interface Traits {
  /** The app runs on the user's PC with its own settings, data updates and app version (`/api/local/*`, the start tile). */
  localApp: boolean;
  /** Exactly one user: nothing has to say who did something or through what (the history's "who" and "source"). */
  singleUser: boolean;
  /** The header across the full width with the side bar below it, the app as high as the window; else the top bar. */
  sideLayout: boolean;
}

/** Until the capabilities are known the online behaviour applies. */
export function traitsOf(caps: NavCaps | null): Traits {
  const none = caps?.login === "none";
  return { localApp: none, singleUser: none, sideLayout: none };
}

const HOME: NavItem ={ to: "/", label: "nav.home", icon: "overview" };
const DATA: NavItem[] = [
  { to: "/gear", label: "nav.components", icon: "gear" },
  { to: "/resources", label: "nav.stock", icon: "type-crate" },
  { to: "/refinery", label: "nav.refinery", icon: "drop" },
  { to: "/blueprints", label: "nav.blueprints", icon: "blueprint" },
];
const TRADE: NavItem = { to: "/trade", label: "nav.trade", icon: "trade" };
const TOOLS: NavItem[] = [
  { to: "/crafting", label: "nav.crafting", icon: "crafter" },
  { to: "/mining", label: "nav.mining", icon: "pickaxe" },
];

/** The three tab bars: the overview, the data views, the tools (the buy/sell tab only where UEX data is offered). */
export function navGroups(caps: NavCaps | null): NavItem[][] {
  return [[HOME], DATA, caps?.uex === false ? TOOLS : [...TOOLS, TRADE]];
}

const HISTORY: NavItem = { to: "/history", label: "nav.history", icon: "history", secondary: true };

/**
 * The side bar's groups (singleuser): the top bar's three, then the history on its own, quieter. Without UEX data the buy/sell
 * entry stays in its place, disabled (the side bar greys it out and says why).
 */
export function sideGroups(caps: NavCaps | null): NavItem[][] {
  const [home, data, tools] = navGroups(caps) as [NavItem[], NavItem[], NavItem[]];
  return [home, data, caps?.uex === false ? [...tools, { ...TRADE, disabled: true }] : tools, [HISTORY]];
}

// --- the side bar's width (singleuser) ---

export type SideMode = "wide" | "narrow";

/** Below this window width the side bar is narrow whatever the user chose (the choice itself stays). */
export const SIDE_NARROW_BELOW = 1000;

/** The stored choice; anything else is wide. */
export const parseSideMode = (stored: string | null): SideMode => (stored === "narrow" ? "narrow" : "wide");

/** The mode in effect for a window width. */
export const sideModeFor = (choice: SideMode, windowWidth: number): SideMode => (windowWidth < SIDE_NARROW_BELOW ? "narrow" : choice);

/** The controls at the right end of the bar. `history` is in both variants. */
export function userControls(caps: NavCaps | null) {
  const none = caps?.login === "none";
  return {
    settings: none,
    companion: !none,
    user: !none,
    profile: !none,
    logout: !none,
    history: true,
  };
}

/** Whether a route exists for these capabilities (the others redirect home). */
export function routeAllowed(path: string, caps: NavCaps | null): boolean {
  if (!caps) return true;
  if (path === "/settings") return caps.login === "none";
  if (path === "/trade") return caps.uex;
  return true;
}
