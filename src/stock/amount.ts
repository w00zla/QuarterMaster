// Amounts as users type them and as Postgres stores them (NUMERIC(14,6), passed as strings).
// Pure: no JS floats on the way, the decimal string is validated and normalized as text.
import { toMicros } from '../planner/plan.ts';

export type SubjectKind = 'resource' | 'item';

// NUMERIC(14,6): at most 8 digits before the point
const MAX_INTEGER_DIGITS = 8;
const MAX_DECIMALS = 6;

/**
 * "12,5" / "12.5" / " 0.046 " → "12.5"; null for anything that is not a positive amount
 * (resources: SCU with up to 6 decimals; items: whole pieces).
 */
export function parseAmount(text: string, kind: SubjectKind): string | null {
  const m = /^(\d+)(?:[.,](\d+))?$/.exec(text.trim());
  if (!m) return null;
  const int = m[1]!.replace(/^0+(?=\d)/, '');
  const frac = (m[2] ?? '').replace(/0+$/, '');
  if (int.length > MAX_INTEGER_DIGITS || frac.length > MAX_DECIMALS) return null;
  if (kind === 'item' && frac) return null;
  if (/^0+$/.test(int) && !frac) return null;
  return frac ? `${int}.${frac}` : int;
}

/** Postgres NUMERIC text ("12.500000", "-3.000000") without trailing zeros: "12.5", "-3". */
export function formatAmount(numeric: string): string {
  return numeric.includes('.') ? numeric.replace(/0+$/, '').replace(/\.$/, '') : numeric;
}

/**
 * An amount's worth at a price (UEX: aUEC per SCU or piece) in micro aUEC: the amount exact (BigInt
 * micro units), the price to 6 decimals. Sum these, round at the end.
 */
export const valueMicros = (amount: string, price: number): bigint => toMicros(amount) * BigInt(Math.round(price * 1e6)) / 1_000_000n;

/** Micro aUEC as whole aUEC (half up). */
export const wholeOfMicros = (micros: bigint): bigint => (micros + 500_000n) / 1_000_000n;
