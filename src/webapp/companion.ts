// The companion app's side of the API contract: which requests are the companion's (the identity decides) and the
// one version check every such request passes. The contract is numbered (COMPANION_API in api-types.ts), not the apps:
// a companion says which number it was built for, the server which range it accepts. Design: docs/webapp.md "Companion".
import type { Context } from 'hono';
import { COMPANION_API, COMPANION_API_MIN, type CompanionOutdated, type ServerOutdated } from './api-types.ts';

/** The companion's app version (x.y.z): for logs and labels only, never decided on. */
export const COMPANION_HEADER = 'x-qm-companion';
/** The API contract number the companion was built for. */
export const COMPANION_API_HEADER = 'x-qm-companion-api';

/**
 * The refusal for a companion request whose contract number is outside the server's range, null when it fits.
 * Missing, malformed or below the minimum: 426 `companionOutdated`; above the server's own number: 409 `serverOutdated`.
 * Neither answer carries any data or links.
 */
export function companionApiRefusal(c: Context): Response | null {
  const raw = c.req.header(COMPANION_API_HEADER);
  const api = raw !== undefined && /^\d{1,9}$/.test(raw.trim()) ? Number(raw.trim()) : -1;
  if (api < COMPANION_API_MIN) return c.json({ error: 'companionOutdated', apiMin: COMPANION_API_MIN } satisfies CompanionOutdated, 426);
  if (api > COMPANION_API) return c.json({ error: 'serverOutdated', apiMax: COMPANION_API } satisfies ServerOutdated, 409);
  return null;
}
