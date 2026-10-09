// Text input of /qm-refinery: one line per ore (start) or per finished ore (done), and the duration.
// Pure, no Discord: tested in test/bot-refinery.test.ts.
import { parseAmount } from '../stock/amount.ts';
import { findOre, norm, type OreCatalog } from '../stock/ore-names.ts';

/**
 * Seconds of "2h 30m", "45m", "2h", "41m 20s", "1d 2h" (also without spaces) or plain minutes ("150");
 * null when it is none of these or zero.
 */
export function parseDuration(text: string): number | null {
  const t = text.trim().toLowerCase();
  if (/^\d+$/.test(t)) return Number(t) > 0 ? Number(t) * 60 : null;
  const units: Record<string, number> = { d: 86400, h: 3600, m: 60, s: 1 };
  const re = /(\d+)\s*([dhms])/gy;
  let seconds = 0;
  let pos = 0;
  const seen = new Set<string>();
  for (;;) {
    while (t[pos] === ' ') pos++;
    if (pos >= t.length) break;
    re.lastIndex = pos;
    const m = re.exec(t);
    // Each unit once ("2h 3h" is a typo, not 5h)
    if (!m || seen.has(m[2]!)) return null;
    seen.add(m[2]!);
    seconds += Number(m[1]) * units[m[2]!]!;
    pos = re.lastIndex;
  }
  return seconds > 0 ? seconds : null;
}

/** "2h 41m", "45m", "1d 3h", "20s": the largest two units, as the terminal shows it. */
export function formatDuration(seconds: number): string {
  const parts: [number, string][] = [[Math.floor(seconds / 86400), 'd'], [Math.floor(seconds / 3600) % 24, 'h'],
    [Math.floor(seconds / 60) % 60, 'm'], [seconds % 60, 's']];
  const first = parts.findIndex(([n]) => n > 0);
  if (first < 0) return '0s';
  return parts.slice(first, first + 2).filter(([n]) => n > 0).map(([n, u]) => `${n}${u}`).join(' ');
}

export type LineError = 'format' | 'quality' | 'amount' | 'yield' | 'ore';

export interface OreLine {
  // 1-based line number in the text as typed
  line: number;
  text: string;
  oreUuid: string;
  quality: number;
  // Exact SCU text (parseAmount)
  amount: string;
  // The user's own expected yield, if given
  expectedYield?: string;
}

export interface OreLines {
  rows: OreLine[];
  errors: { line: number; text: string; error: LineError }[];
  // More ore lines than a work order takes
  tooMany: boolean;
}

const NUMBER = /^\d+(?:[.,]\d+)?$/;

/** A refined amount: like an amount, but 0 is allowed (nothing came out of a tiny ore row). */
export function parseYield(text: string): string | null {
  return /^0+(?:[.,]0+)?$/.test(text.trim()) ? '0' : parseAmount(text, 'resource');
}

/** The ore a typed name means; "heph raw" and "ice ore" are also read as "heph (raw)", "ice (ore)". */
export function resolveOre(cat: OreCatalog, name: string): string | null {
  const found = findOre(cat, name);
  if (found) return found;
  const suffix = /^(.*\S)\s+(raw|r|ore)$/i.exec(name.trim());
  return suffix ? findOre(cat, `${suffix[1]} (${suffix[2]})`) : null;
}

/**
 * `<ore name> <quality> <amount> [expected yield]` per line, numbers read from the right (the name may hold
 * spaces and parentheses); "Q820" and a trailing "SCU" are accepted. Empty lines are skipped.
 */
export function parseOreLines(text: string, cat: OreCatalog, maxRows: number): OreLines {
  const result: OreLines = { rows: [], errors: [], tooMany: false };
  text.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim();
    if (!line) return;
    const tokens = line.split(/\s+/).filter((tok) => tok.toLowerCase() !== 'scu');
    const numbers: string[] = [];
    while (numbers.length < 3 && tokens.length > 1) {
      const last = tokens[tokens.length - 1]!.replace(/^q(?=\d)/i, '');
      if (!NUMBER.test(last)) break;
      numbers.unshift(last);
      tokens.pop();
    }
    const fail = (error: LineError) => void result.errors.push({ line: i + 1, text: line, error });
    if (numbers.length < 2 || !tokens.length) return fail('format');
    const [qualityText, amountText, yieldText] = numbers as [string, string, string?];
    if (!/^\d+$/.test(qualityText) || Number(qualityText) > 1000) return fail('quality');
    const amount = parseAmount(amountText, 'resource');
    if (!amount) return fail('amount');
    const expectedYield = yieldText === undefined ? undefined : parseYield(yieldText);
    if (expectedYield === null) return fail('yield');
    const oreUuid = resolveOre(cat, tokens.join(' '));
    if (!oreUuid) return fail('ore');
    result.rows.push({ line: i + 1, text: line, oreUuid, quality: Number(qualityText), amount, ...(expectedYield === undefined ? {} : { expectedYield }) });
  });
  result.tooMany = result.rows.length > maxRows;
  return result;
}

// --- done: one line per ore of the job ---------------------------------------------------------

export interface DoneRow {
  // The ore's name as shown when the modal opened
  name: string;
  quality: number;
  // Prefill: the expected yield, if known
  expected: string | null;
}

/** "Quantanium 820: 5.69" per ore ("Quantanium 820: " without an expected yield). */
export function doneText(rows: DoneRow[]): string {
  return rows.map((r) => `${r.name} ${r.quality}: ${r.expected ?? ''}`.trimEnd()).join('\n');
}

export type DoneError = 'lines' | 'mismatch' | 'yield';

/**
 * The refined amounts in the order of `rows`; the lines must keep their order, ore name and quality
 * (only the number after the colon is the user's).
 */
export function parseDoneText(text: string, rows: DoneRow[]): { amounts: string[] } | { error: DoneError; line?: number } {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length !== rows.length) return { error: 'lines' };
  const amounts: string[] = [];
  for (const [i, line] of lines.entries()) {
    const m = /^(.*?)\s*(\d+)\s*:\s*(\S*)$/.exec(line);
    const row = rows[i]!;
    if (!m || norm(m[1]!) !== norm(row.name) || Number(m[2]) !== row.quality) return { error: 'mismatch', line: i + 1 };
    const amount = m[3] ? parseYield(m[3]) : null;
    if (amount === null) return { error: 'yield', line: i + 1 };
    amounts.push(amount);
  }
  return { amounts };
}
