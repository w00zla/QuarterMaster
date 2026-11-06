// How a ship component's stored stat reads (from sc-quartermaster's src/stock/component-stats.ts). A stat is
// stored like the crafting check shows it: a multiplier as its change in percent ("12.5" = +12.5 %, one
// decimal), additive steps as a whole number ("1" = +1 power pip).

/** A stored value as shown: "+12.5 %", "−3 %" (multiplier), "+1" (steps). */
export function statValueText(kind: "multiplier" | "additive", value: string): string {
  const n = Number(value);
  const sign = n > 0 ? "+" : n < 0 ? "−" : "±";
  const abs = kind === "multiplier" ? Math.abs(n).toFixed(1) : String(Math.abs(n));
  return kind === "multiplier" ? `${sign}${abs} %` : `${sign}${abs}`;
}
