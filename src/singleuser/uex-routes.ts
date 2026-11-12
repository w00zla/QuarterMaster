// The singleuser UEX routes (docs/singleuser.md "UEX"). They answer from the puller's in-memory state, never from the
// database. Writes are JSON only (the API's rule: send `{}` for the pull).
import type { UexState } from '../webapp/api-types.ts';
import type { ApiApp } from '../webapp/app.ts';
import type { UexPuller } from './uex.ts';

export function mountUexRoutes(puller: UexPuller): (api: ApiApp) => void {
  return (api) => {
    api.get('/local/uex', (c) => c.json(puller.state() satisfies UexState));

    // Starts a pull and answers with the state at once (phase `pulling`, or the running pull's); 409 without a key
    api.post('/local/uex/pull', (c) => {
      if (puller.state().phase === 'off') return c.json({ error: 'noKey' }, 409);
      void puller.pullNow();
      return c.json(puller.state() satisfies UexState);
    });
  };
}
