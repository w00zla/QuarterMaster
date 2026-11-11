// Which navigation the top bar and the router offer for a server's capabilities (pure: tested in test/webapp-local.test.ts).
// (No imports of Vue files or i18n: the root type check and the tests load this file; `label` and `icon` are literal
// strings that the top bar checks against the text keys and the icon map.)

export interface NavItem {
  to: string;
  label: "nav.home" | "nav.components" | "nav.stock" | "nav.refinery" | "nav.blueprints" | "nav.crafting" | "nav.mining" | "nav.trade";
  icon: "overview" | "gear" | "type-crate" | "drop" | "blueprint" | "crafter" | "pickaxe" | "trade";
}

/** What the navigation needs of GET /api/capabilities. */
export interface NavCaps {
  login: "discord" | "none";
  orgs: boolean;
  uex: boolean;
}

const HOME: NavItem = { to: "/", label: "nav.home", icon: "overview" };
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
