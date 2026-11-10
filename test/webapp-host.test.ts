// The Host guard (DNS rebinding): WebappConfig.allowedHosts for HTTP, RealtimeOptions.allowedHosts for the WebSocket
// handshake. No database: the checks come before everything that needs one.
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import WebSocket from 'ws';
import type { Db } from '../src/db/client.ts';
import { createApp, type WebappConfig } from '../src/webapp/app.ts';
import type { Identity } from '../src/webapp/identity.ts';
import { RealtimeHub } from '../src/webapp/realtime.ts';

const ORIGIN = 'http://127.0.0.1:28460';
const HOSTS = ['127.0.0.1:28460', 'localhost:28460'];
const identity: Identity = {
  acceptsWrite: () => true,
  mountRoutes() {},
  authenticate: async (c) => { c.set('session', { userId: '00000000000000000', username: 'local', globalName: 'Local', avatar: null }); return undefined; },
  mountApiRoutes() {},
  authenticateDownload: async () => undefined,
  authenticateUpgrade: async () => ({ userId: '00000000000000000', valid: async () => true }),
};
const db = { execute: async () => [] } as unknown as Db;
const build = (extra: Partial<WebappConfig> = {}) =>
  createApp(db, identity, { origin: ORIGIN, trustProxy: false, distDir: null, capabilities: { login: 'none', orgs: false, uex: false }, ...extra });

describe('Host guard, HTTP', () => {
  const guarded = build({ allowedHosts: HOSTS });

  it('both local hosts are served', async () => {
    for (const host of HOSTS) {
      const res = await guarded.request('/api/capabilities', { headers: { host } });
      assert.equal(res.status, 200, host);
    }
  });
  it('any other Host, or none, is refused with 421 and a JSON error, before anything else', async () => {
    for (const headers of [{ host: 'evil.example' }, { host: 'evil.example:28460' }, { host: '127.0.0.1' }, { host: '127.0.0.1:28461' }, { host: 'localhost' }, {}] as Record<string, string>[]) {
      for (const path of ['/api/capabilities', '/api/me', '/', '/thumbs/s/x.avif']) {
        const res = await guarded.request(path, { headers });
        assert.equal(res.status, 421, `${path} ${JSON.stringify(headers)}`);
        assert.deepEqual(await res.json(), { error: 'host not allowed' });
      }
    }
    // Writes too
    const res = await guarded.request('/api/profile', { method: 'POST', headers: { host: 'evil.example', 'content-type': 'application/json' }, body: '{}' });
    assert.equal(res.status, 421);
  });
  it('the host name is compared in lower case', async () => {
    assert.equal((await guarded.request('/api/capabilities', { headers: { host: 'LocalHost:28460' } })).status, 200);
  });
  it('a page request on localhost goes to the canonical origin, path and query kept; API requests just work', async () => {
    const res = await guarded.request('/some/page?x=1', { headers: { host: 'localhost:28460' } });
    assert.equal(res.status, 307);
    assert.equal(res.headers.get('location'), `${ORIGIN}/some/page?x=1`);
    for (const path of ['/api/capabilities', '/api/me', '/thumbs/s/x.avif']) {
      assert.notEqual((await guarded.request(path, { headers: { host: 'localhost:28460' } })).status, 307, path);
    }
    // The canonical host is never redirected
    assert.notEqual((await guarded.request('/some/page', { headers: { host: '127.0.0.1:28460' } })).status, 307);
    // Only reads of pages
    const post = await guarded.request('/x', { method: 'POST', headers: { host: 'localhost:28460' } });
    assert.notEqual(post.status, 307);
  });
  it('online (no list): no check, any Host, no redirect', async () => {
    const online = build();
    for (const headers of [{ host: 'evil.example' }, { host: 'localhost:28460' }, {}] as Record<string, string>[]) {
      assert.equal((await online.request('/api/capabilities', { headers })).status, 200);
    }
    assert.notEqual((await online.request('/some/page', { headers: { host: 'localhost:28460' } })).status, 307);
  });
});

describe('Host guard, WebSocket handshake', () => {
  let hub: RealtimeHub;
  let open: RealtimeHub;
  let port: number;
  let openPort: number;
  const servers: Server[] = [];
  const listen = async (h: RealtimeHub) => {
    const s = createServer((_req, res) => res.end());
    s.on('upgrade', (req, sock, head) => h.handleUpgrade(req, sock, head));
    await new Promise<void>((resolve) => s.listen(0, '127.0.0.1', resolve));
    servers.push(s);
    return (s.address() as AddressInfo).port;
  };
  before(async () => {
    hub = new RealtimeHub(db, identity, { origin: ORIGIN, trustProxy: false, allowedHosts: HOSTS }, () => {});
    open = new RealtimeHub(db, identity, { origin: ORIGIN, trustProxy: false }, () => {});
    port = await listen(hub);
    openPort = await listen(open);
  });
  after(async () => {
    hub.close();
    open.close();
    for (const s of servers) await new Promise((r) => s.close(r));
  });

  // Resolves with the refusal's status or 'open'
  const handshake = (p: number, host: string) => new Promise<number | 'open'>((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${p}/api/ws`, { headers: { host, origin: ORIGIN } });
    ws.once('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0));
    ws.once('open', () => { ws.terminate(); resolve('open'); });
    ws.once('error', () => {});
  });

  it('a foreign Host gets 421, both local hosts get a socket', async () => {
    assert.equal(await handshake(port, 'evil.example:28460'), 421);
    assert.equal(await handshake(port, '127.0.0.1:28461'), 421);
    assert.equal(await handshake(port, '127.0.0.1:28460'), 'open');
    assert.equal(await handshake(port, 'localhost:28460'), 'open');
  });
  it('online (no list): unchanged', async () => {
    assert.equal(await handshake(openPort, 'evil.example'), 'open');
  });
});
