// Short-lived state behind buttons (confirmations, list pages): a button's custom ID only carries a
// random token, the data stays here. In memory: a bot restart just means "please run it again".
import { randomBytes } from 'node:crypto';

interface Entry {
  userId: string;
  expires: number;
  value: unknown;
}

const entries = new Map<string, Entry>();

export const CONFIRM_TTL_MS = 10 * 60_000;
export const LIST_TTL_MS = 15 * 60_000;

/** Stores a value for this user; returns the token for the custom ID. */
export function putState(userId: string, value: unknown, ttlMs: number): string {
  const now = Date.now();
  for (const [token, e] of entries) if (e.expires < now) entries.delete(token);
  const token = randomBytes(8).toString('hex');
  entries.set(token, { userId, expires: now + ttlMs, value });
  return token;
}

export type StateLookup<T> = { ok: true; value: T } | { ok: false; reason: 'expired' | 'foreign' };

/** The value behind a token, only for the user who created it; `take` removes it (one-time use). */
export function getState<T>(token: string, userId: string, take = false): StateLookup<T> {
  const e = entries.get(token);
  if (!e || e.expires < Date.now()) {
    entries.delete(token);
    return { ok: false, reason: 'expired' };
  }
  if (e.userId !== userId) return { ok: false, reason: 'foreign' };
  if (take) entries.delete(token);
  return { ok: true, value: e.value as T };
}
