import type { BlueprintInput } from "../../src/adminapp/api-types";

export function duration(seconds: number | null): string {
  if (seconds === null) return "—";
  const s = Math.round(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const rest = s % 60;
  return [h ? `${h}h` : "", m ? `${m}m` : "", rest || (!h && !m) ? `${rest}s` : ""].filter(Boolean).join(" ");
}

export function quantity(input: Pick<BlueprintInput, "kind" | "quantity">): string {
  return input.kind === "resource" ? `${input.quantity} SCU` : `×${input.quantity}`;
}

export function dateTime(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

// Tag style of a text source: the app's own texts, external files, the game.
export function sourceTag(source: string): Record<string, boolean> {
  return { app: source === "app", accent: source !== "app" && source !== "game" };
}

// Case-insensitive "contains" over several fields.
export function matches(query: string, ...fields: (string | number | null | undefined)[]): boolean {
  const q = query.trim().toLowerCase();
  return !q || fields.some((f) => f !== null && f !== undefined && String(f).toLowerCase().includes(q));
}
