// Admin web UI: JSON API (catalog reads, catalog/localization imports, read-only user data, the bot's status texts) plus the built SPA (adminapp/dist),
// behind HTTP basic auth. Binds to 127.0.0.1 unless ADMINAPP_HOST says otherwise; in production it sits
// behind Caddy (TLS) and is published on the host's loopback only (compose.yaml).
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono, type Context } from 'hono';
import { basicAuth } from 'hono/basic-auth';
import { bodyLimit } from 'hono/body-limit';
import { HTTPException } from 'hono/http-exception';
import { connect } from '../db/client.ts';
import * as a from './activity.ts';
import { runImport, summarize, textDiffCounts } from '../catalog/import/apply.ts';
import { loadSnapshot } from '../catalog/import/load.ts';
import { parseIniFile, runLocImport, runLocRemove } from '../catalog/import/loc-import.ts';
import type { CatalogImportResponse, LocImportResponse } from './api-types.ts';
import { getMiningProvider, getMiningProviders } from './mining.ts';
import * as q from './queries.ts';
import { getStatus } from './status.ts';
import * as s from './status-quotes.ts';
import * as st from './stock.ts';
import * as u from './users.ts';

const { ADMINAPP_USER, ADMINAPP_PASSWORD, ADMINAPP_HOST = '127.0.0.1', ADMINAPP_PORT = '3000' } = process.env;
if (!ADMINAPP_USER || !ADMINAPP_PASSWORD) {
  console.error('ADMINAPP_USER and ADMINAPP_PASSWORD must be set (see .env.example)');
  process.exit(1);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// Discord IDs (the schema's format check)
const SNOWFLAKE = /^[0-9]{17,20}$/;
const DIST = fileURLToPath(new URL('../../adminapp/dist', import.meta.url));

const { db, close } = connect(process.env.DATABASE_URL);
const app = new Hono();

app.use('*', basicAuth({ username: ADMINAPP_USER, password: ADMINAPP_PASSWORD, realm: 'SC Quartermaster' }));

// Languages are validated against the ones with texts; anything else falls back to English
let langs = new Set<string>();
const refreshLangs = async () => {
  langs = new Set((await q.getMeta(db)).langs);
};
const lang = (c: Context) => {
  const l = c.req.query('lang') ?? 'en';
  return langs.has(l) ? l : 'en';
};
const uuid = (c: Context) => {
  const id = c.req.param('uuid') ?? '';
  return UUID.test(id) ? id : null;
};
const found = <T>(c: Context, value: T | null) => (value === null ? c.json({ error: 'not found' }, 404) : c.json(value));

const api = new Hono();
api.get('/meta', async (c) => {
  const meta = await q.getMeta(db);
  langs = new Set(meta.langs);
  return c.json(meta);
});
api.get('/overview', async (c) => c.json(await q.getOverview(db, lang(c))));
api.get('/imports', async (c) => c.json(await q.getImports(db)));
api.get('/imports/:id', async (c) => {
  const id = Number(c.req.param('id'));
  return found(c, Number.isInteger(id) ? await q.getImport(db, id) : null);
});
api.get('/blueprints', async (c) => c.json(await q.getBlueprints(db, lang(c))));
api.get('/blueprints/:uuid', async (c) => {
  const id = uuid(c);
  return found(c, id ? await q.getBlueprint(db, id, lang(c)) : null);
});
api.get('/resources', async (c) => c.json(await q.getResources(db, lang(c))));
api.get('/resources/:uuid', async (c) => {
  const id = uuid(c);
  return found(c, id ? await q.getResource(db, id, lang(c)) : null);
});
api.get('/items', async (c) => c.json(await q.getItems(db, lang(c))));
api.get('/items/:uuid', async (c) => {
  const id = uuid(c);
  return found(c, id ? await q.getItem(db, id, lang(c)) : null);
});
api.get('/mining', async (c) => c.json(await getMiningProviders(db, lang(c))));
api.get('/mining/:uuid', async (c) => {
  const id = uuid(c);
  return found(c, id ? await getMiningProvider(db, id, lang(c)) : null);
});
api.get('/localization/sources', async (c) => c.json(await q.getLocSources(db)));
api.get('/ext/uex', async (c) => c.json(await q.getUex(db, lang(c))));
api.get('/ext/uex/trade', async (c) => c.json(await q.getUexTrade(db, lang(c))));
api.get('/localization/search', async (c) => {
  const query = (c.req.query('q') ?? '').trim();
  const limit = Math.min(Math.max(Number(c.req.query('limit')) || 200, 1), 1000);
  return c.json(query ? await q.searchLoc(db, lang(c), query, limit) : { total: 0, rows: [] });
});
api.get('/localization/keys/:key', async (c) => c.json(await q.getLocKey(db, c.req.param('key').toLowerCase())));
// --- users and orgs (read-only) ---
const snowflake = (c: Context, name: string) => {
  const id = c.req.param(name) ?? '';
  return SNOWFLAKE.test(id) ? id : null;
};
api.get('/orgs', async (c) => c.json(await u.getOrgs(db)));
api.get('/orgs/:guildId', async (c) => {
  const id = snowflake(c, 'guildId');
  return found(c, id ? await u.getOrg(db, id, lang(c)) : null);
});
api.get('/users', async (c) => c.json(await u.getUsers(db)));
api.get('/users/:userId', async (c) => {
  const id = snowflake(c, 'userId');
  return found(c, id ? await u.getUser(db, id, lang(c)) : null);
});
api.get('/checks', async (c) => c.json(await u.getDataChecks(db, lang(c))));
api.get('/status', async (c) => c.json(await getStatus(db)));
// --- dashboard and activity (read-only) ---
api.get('/dashboard', async (c) => {
  const days = a.DASHBOARD_DAYS.find((d) => String(d) === c.req.query('days')) ?? 30;
  return c.json(await a.getDashboard(db, lang(c), days));
});
api.get('/activity', async (c) => c.json(await a.getActivity(db, lang(c), a.activityFilter((name) => c.req.query(name)))));
// --- stock and refinery (read-only) ---
api.get('/stock', async (c) => c.json(await st.getStock(db, lang(c))));
api.get('/stock/:kind/:uuid', async (c) => {
  const kind = c.req.param('kind');
  const id = uuid(c);
  return found(c, id && (kind === 'resource' || kind === 'item') ? await st.getStockSubject(db, kind, id, lang(c)) : null);
});
api.get('/refinery', async (c) => c.json(await st.getRefineryJobs(db, lang(c))));
// --- imports (write) ----------------------------------------------------------------
// The file is the raw request body. Writing endpoints require a custom header: a form on
// another site cannot set it, so the browser's stored basic auth cannot be abused (CSRF).
// Without `dryRun=0` everything is a dry run.
const WRITE_HEADER = 'x-quartermaster';
const MB = 1024 * 1024;
const requireWriteHeader = async (c: Context, next: () => Promise<void>) => {
  if (c.req.header(WRITE_HEADER) !== '1') return c.json({ error: `missing ${WRITE_HEADER} header` }, 403);
  await next();
};
const flag = (c: Context, name: string) => c.req.query(name) === '1';
const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

api.post('/import/catalog', requireWriteHeader, bodyLimit({ maxSize: 300 * MB }), async (c) => {
  // The readable version (4.10.2) is required: snapshots carry none (set at import, not at extract)
  const label = c.req.query('label')?.trim();
  if (!label) return c.json({ error: 'label is required (the game version, e.g. 4.10.2)' }, 400);
  let loaded;
  try {
    loaded = loadSnapshot(new Uint8Array(await c.req.arrayBuffer()));
  } catch (err) {
    return c.json({ error: message(err) }, 400);
  }
  const { snapshot, sha256 } = loaded;
  snapshot.game.label = label;
  const result = await runImport(db, snapshot, sha256, {
    dryRun: c.req.query('dryRun') !== '0',
    force: flag(c, 'force'),
    allowDowngrade: flag(c, 'allowDowngrade'),
    maxRetireRatio: 0.1,
    maxChangeRatio: 0.5,
  });
  if (result.status === 'imported') await refreshLangs();
  const s = summarize(result);
  const { manifest: _manifest, ...game } = snapshot.game;
  return c.json({
    status: result.status,
    // A dry run's id belongs to a rolled-back row: only report real imports
    importId: result.status === 'imported' ? result.importId : null,
    game,
    extractedAt: snapshot.extractedAt,
    snapshotSha256: sha256,
    anomalyCount: snapshot.anomalies.length,
    lastImport: result.last && { id: result.last.id, channel: result.last.channel, gameBuild: result.last.gameBuild },
    entities: s.entities as CatalogImportResponse['entities'],
    localization: s.localization as CatalogImportResponse['localization'],
    violations: result.safeguards.violations,
    warnings: result.safeguards.warnings,
  } satisfies CatalogImportResponse);
});

api.post('/import/localization', requireWriteHeader, bodyLimit({ maxSize: 100 * MB }), async (c) => {
  const source = c.req.query('source') ?? '';
  const language = c.req.query('lang') ?? '';
  const priority = c.req.query('priority');
  if (priority !== undefined && priority !== '' && !Number.isInteger(Number(priority))) return c.json({ error: 'priority must be an integer' }, 400);
  const ini = parseIniFile(new Uint8Array(await c.req.arrayBuffer()));
  try {
    const r = await runLocImport(db, ini.texts, {
      source,
      lang: language,
      priority: priority ? Number(priority) : null,
      origin: `upload: ${c.req.query('name') ?? 'global.ini'}`,
      dryRun: c.req.query('dryRun') !== '0',
      force: flag(c, 'force'),
      maxRemoveRatio: 0.5,
      minGameOverlap: 0.5,
    });
    if (r.status === 'imported') await refreshLangs();
    return c.json({
      status: r.status,
      source,
      lang: language,
      priority: r.priority,
      previous: r.previous && { priority: r.previous.priority, keyCount: r.previous.keyCount, importedAt: r.previous.importedAt.toISOString() },
      file: { keys: ini.parsed, placeholders: ini.placeholders, appKeys: ini.appKeys },
      texts: textDiffCounts(r.diff),
      knownToGame: r.knownToGame,
      gameKeys: r.gameKeys,
      wins: r.wins,
      violations: r.violations,
      warnings: r.warnings,
    } satisfies LocImportResponse);
  } catch (err) {
    // Validation errors (source/lang names, empty file, reserved keys)
    return c.json({ error: message(err) }, 400);
  }
});

// Removes an imported text source for one language; the sources game and app are refused
api.delete('/localization/sources/:source/:lang', requireWriteHeader, async (c) => {
  try {
    const removed = await runLocRemove(db, c.req.param('source') ?? '', c.req.param('lang') ?? '', false);
    if (!removed) return c.json({ error: 'not found' }, 404);
    await refreshLangs();
    return c.body(null, 204);
  } catch (err) {
    return c.json({ error: message(err) }, 400);
  }
});

// --- bot status texts (write: JSON body { text }) -------------------------------------------
api.get('/status-quotes', async (c) => c.json(await s.getStatusQuotes(db)));
const quoteBody = async (c: Context) => s.quoteText(((await c.req.json().catch(() => null)) as { text?: unknown } | null)?.text);
const quoteId = (c: Context) => {
  const id = Number(c.req.param('id'));
  return Number.isSafeInteger(id) && id > 0 ? id : null;
};
const TEXT_ERROR = `text must have 1 to ${s.MAX_QUOTE_LENGTH} characters`;
api.post('/status-quotes', requireWriteHeader, async (c) => {
  const text = await quoteBody(c);
  return text === null ? c.json({ error: TEXT_ERROR }, 400) : c.json(await s.addStatusQuote(db, text));
});
api.put('/status-quotes/:id', requireWriteHeader, async (c) => {
  const id = quoteId(c);
  const text = await quoteBody(c);
  if (text === null) return c.json({ error: TEXT_ERROR }, 400);
  return found(c, id ? await s.updateStatusQuote(db, id, text) : null);
});
api.delete('/status-quotes/:id', requireWriteHeader, async (c) => {
  const id = quoteId(c);
  return id && (await s.deleteStatusQuote(db, id)) ? c.body(null, 204) : c.json({ error: 'not found' }, 404);
});

api.notFound((c) => c.json({ error: 'not found' }, 404));
app.route('/api', api);

app.onError((err, c) => {
  // Intended responses such as the basic auth challenge (401)
  if (err instanceof HTTPException) return err.getResponse();
  console.error(err);
  return c.json({ error: 'internal error' }, 500);
});

// The SPA: static files, every other path gets index.html (client-side routing)
if (existsSync(DIST)) {
  app.use('*', serveStatic({ root: DIST }));
  const index = readFileSync(`${DIST}/index.html`, 'utf8');
  app.get('*', (c) => c.html(index));
} else {
  app.get('*', (c) => c.text('SPA not built: run "pnpm adminapp:build", or use "pnpm adminapp:dev" for development.', 404));
}

await refreshLangs();
const server = serve({ fetch: app.fetch, hostname: ADMINAPP_HOST, port: Number(ADMINAPP_PORT) }, (info) => {
  const url = `http://${info.address}:${info.port}`;
  console.log(`Backend (API) on ${url}`);
  console.log(existsSync(DIST) ? `Built UI on ${url}` : 'No built UI (adminapp/dist); in development the UI runs on Vite (pnpm adminapp:dev)');
});

const shutdown = () => server.close(() => void close().then(() => process.exit(0)));
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
