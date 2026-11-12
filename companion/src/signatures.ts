// The radar signature's evaluation (pure, also run by the root's node tests): which rock kinds a signature can
// stand for. A ship's scan shows one node's signature times the cluster's nodes, so a rock kind fits when the
// signature is a whole multiple of its own (the catalog's rock kinds, CompanionCatalogRock). Every mining method's
// rocks: the ship scans for the ROC and hand mining too (the ship carries their gear), and all of them go into crafting.
import type { CompanionCatalogRock } from "../../src/webapp/api-types.ts";

/** A rock kind the signature can stand for: its resource's name, how many nodes, the mining method. */
export interface SignatureMatch {
  name: string;
  count: number;
  method: CompanionCatalogRock["method"];
}

const METHOD_ORDER = { ship: 0, roc: 1, fps: 2 } as const;

/** The rock kinds `value` is a whole multiple of (one per name, count and method: rarities of the same signature are
 * one), fewest nodes first, then by name and method. */
export function matchSignature(value: number, rocks: Pick<CompanionCatalogRock, "name" | "method" | "radarSignature">[]): SignatureMatch[] {
  const found = new Map<string, SignatureMatch>();
  for (const r of rocks) {
    if (!(r.radarSignature > 0)) continue;
    const count = Math.round(value / r.radarSignature);
    // Signatures are whole numbers; half a unit absorbs a fractional catalog value
    if (count < 1 || Math.abs(count * r.radarSignature - value) > 0.5) continue;
    found.set(`${r.name}\u0000${count}\u0000${r.method}`, { name: r.name, count, method: r.method });
  }
  return [...found.values()].sort((a, b) => a.count - b.count || a.name.localeCompare(b.name) || METHOD_ORDER[a.method] - METHOD_ORDER[b.method]);
}

/** "3 × Gold" */
export const matchText = (m: SignatureMatch) => `${m.count} × ${m.name}`;

/** A signature as the game writes it ("42,000"), whatever the UI language. */
export const signatureText = (value: number) => value.toLocaleString("en-US");
