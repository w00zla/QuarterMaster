// The singleuser variant's data update routes (docs/singleuser.md "Updating the data"). They answer from the updater's
// in-memory state: never from the database, so they answer while an install holds it. Writes are JSON only (the API's
// rule: send `{}` for the check).
import { statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import type { DataUpdater } from '../datapack/updater.ts';
import type { DataUpdateState } from '../webapp/api-types.ts';
import type { ApiApp } from '../webapp/app.ts';

export function mountDataRoutes(updater: DataUpdater): (api: ApiApp) => void {
  return (api) => {
    api.get('/local/data', (c) => c.json(updater.state() satisfies DataUpdateState));

    // Starts the check and answers with the state at once (phase `checking`, or the running operation's)
    api.post('/local/data/check', (c) => {
      void updater.check();
      return c.json(updater.state() satisfies DataUpdateState);
    });

    api.post('/local/data/import', async (c) => {
      const body: unknown = await c.req.json().catch(() => null);
      const path = (body as { path?: unknown } | null)?.path;
      if (typeof path !== 'string' || path === '') return c.json({ error: 'path is required' }, 400);
      if (!isAbsolute(path)) return c.json({ error: 'path must be absolute' }, 400);
      let isFile = false;
      try {
        isFile = statSync(path).isFile();
      } catch { /* not there */ }
      if (!isFile) return c.json({ error: 'file not found' }, 404);
      void updater.importFile(path);
      return c.json(updater.state() satisfies DataUpdateState);
    });
  };
}
