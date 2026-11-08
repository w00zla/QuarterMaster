// The user's own filters for the inventory scan (the dialog "Benutzerfilter" in the Gear and Resources
// heads): wildcard terms ("*Rifle*", "Quantanium", "?-Kit") each for one kind or all, matched against an
// item's names (catalog de and en, the tooltip's title) as a whole, case aside. What one matches makes no
// proposal (the debug window lists it as filtered). Pure: the list and its switch live in inventorySync.ts.

// The inventory scan's kinds (inventorySync.ts has their filter): comps = ship components, fps = FPS gear (2026-10-22)
export type Kind = "mats" | "items" | "comps" | "fps";
export type FilterKind = Kind | "all";
export const FILTER_KINDS: FilterKind[] = ["all", "mats", "items", "comps", "fps"];

export interface UserFilter {
  pattern: string;
  kind: FilterKind;
}

/** The pattern as a regex: `*` any text, `?` one character, the rest literal; the whole name, case aside. */
export function wildcard(pattern: string): RegExp {
  const body = [...pattern.trim()].map((c) => (c === "*" ? ".*" : c === "?" ? "." : c.replace(/[.+^${}()|[\]\\]/g, "\\$&"))).join("");
  return new RegExp(`^${body}$`, "iu");
}

/** The first filter that matches one of the names (an item of `kind`; null = not known: every kind's filter
 * applies), its pattern; null when none does. */
export function filteredBy(filters: readonly UserFilter[], kind: Kind | null, names: readonly string[]): string | null {
  for (const f of filters) {
    if (f.kind !== "all" && kind !== null && f.kind !== kind) continue;
    const re = wildcard(f.pattern);
    if (names.some((n) => re.test(n.trim()))) return f.pattern;
  }
  return null;
}

/** A stored list as far as it is valid (entries with an empty pattern or an unknown kind are dropped). */
export function parseFilters(stored: unknown): UserFilter[] {
  if (!Array.isArray(stored)) return [];
  return stored.flatMap((f: unknown) => {
    const { pattern, kind } = (f ?? {}) as { pattern?: unknown; kind?: unknown };
    return typeof pattern === "string" && pattern.trim() && FILTER_KINDS.includes(kind as FilterKind) ? [{ pattern: pattern.trim(), kind: kind as FilterKind }] : [];
  });
}
