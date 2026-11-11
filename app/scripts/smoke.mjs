// The desktop app's smoke test: builds everything (pnpm app:build), then starts the BUILT executable (not the installer) on
// temp folders and checks what can be checked without looking at the screen: the server comes up as a node child, the
// pairing file, the API and the SPA; a close request ends both processes and removes the pairing file and the lock; a
// killed app leaves no server behind and the next start takes over a stale lock; the shell contract answers from the web
// app's page and from nowhere else; the updater against a local feed; a second start on the same folder; the single instance.
// Nothing is installed, no screenshot is taken, no request leaves the machine (the feeds are local). Every wait has a
// hard limit and every process started here is killed at the end, whatever happened. docs/app.md "Tests".
//   node app/scripts/smoke.mjs [--no-build] [--exe <file>] [--only <scenario>[,<scenario>]]
import { execSync, spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const root = fileURLToPath(new URL('../../', import.meta.url));
const args = process.argv.slice(2);
const option = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const windows = process.platform === 'win32';
const exe = option('--exe') ?? join(root, 'app', 'src-tauri', 'target', 'release', windows ? 'quartermaster.exe' : 'quartermaster');
const only = option('--only')?.split(',');

const BUILD_LIMIT = 45 * 60_000;
const RUN_LIMIT = 12 * 60_000;
const READY_LIMIT = 90_000;
const EXIT_LIMIT = 15_000;

const log = (message) => console.log(`[smoke] ${message}`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Polls `probe` until it returns something truthy; throws `what` after `limit` ms. */
async function until(probe, limit, what) {
  const end = Date.now() + limit;
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() > end) throw new Error(`timeout after ${limit / 1000} s: ${what}`);
    await sleep(150);
  }
}

const freePort = () => new Promise((resolve, reject) => {
  const probe = createServer();
  probe.once('error', reject);
  probe.listen(0, '127.0.0.1', () => {
    const { port } = probe.address();
    probe.close(() => resolve(port));
  });
});

// --- processes ---

/** Every process as { pid, ppid, name }. */
function processes() {
  const result = windows
    ? spawnSync('powershell', ['-NoProfile', '-Command', 'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId) $($_.Name)" }'], { encoding: 'utf8', timeout: 60_000 })
    : spawnSync('ps', ['-eo', 'pid=,ppid=,comm='], { encoding: 'utf8', timeout: 60_000 });
  if (result.status !== 0) throw new Error(`process list failed: ${result.stderr}`);
  return result.stdout.split('\n').map((line) => /^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(line)).filter(Boolean).map((m) => ({ pid: Number(m[1]), ppid: Number(m[2]), name: m[3] }));
}

const childrenOf = (pid) => processes().filter((p) => p.ppid === pid);
const isNode = (p) => /^node(\.exe)?$/i.test(p.name);

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** A close request to the app's window, as the system sends it (Alt+F4, the taskbar's "close"): not a kill. */
function requestClose(pid) {
  if (!windows) return void process.kill(pid, 'SIGTERM');
  const result = spawnSync('powershell', ['-NoProfile', '-Command', `(Get-Process -Id ${pid}).CloseMainWindow()`], { encoding: 'utf8', timeout: 30_000 });
  assert.match(result.stdout, /True/, `the window of process ${pid} took no close request: ${result.stdout}${result.stderr}`);
}

function killHard(pid, tree) {
  if (windows) spawnSync('taskkill', ['/F', ...(tree ? ['/T'] : []), '/PID', String(pid)], { timeout: 30_000 });
  else spawnSync('kill', ['-9', String(pid)], { timeout: 30_000 });
}

// --- the app ---

const started = [];
const work = mkdtempSync(join(tmpdir(), 'qm-app-smoke-'));

/** The environment without anything of the developer's own setup. */
function cleanEnv() {
  const env = { ...process.env };
  for (const name of Object.keys(env)) if (/^(QM_|WEBVIEW2_|NODE_OPTIONS$)/i.test(name)) delete env[name];
  return env;
}

/** One run's folders and ports; `env` is what the app is started with. */
async function scenarioEnv(name, feed, extra = {}) {
  const dir = join(work, name);
  mkdirSync(dir, { recursive: true });
  const debugPort = await freePort();
  const env = {
    ...cleanEnv(),
    QM_DATA_DIR: join(dir, 'data'),
    QM_PAIRING_FILE: join(dir, 'pairing.json'),
    QM_AUTO_UPDATE: '0',
    QM_PORT: String(await freePort()),
    QM_APP_CONFIG: join(dir, 'config.json'),
    // Never GitHub: the app's feed and the server's data feed are local
    QM_APP_FEED: feed.url,
    QM_DATA_FEED: join(dir, 'no-data-feed'),
    WEBVIEW2_USER_DATA_FOLDER: join(dir, 'webview'),
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${debugPort}`,
    ...extra,
  };
  for (const [key, value] of Object.entries(env)) if (value === undefined) delete env[key];
  mkdirSync(join(dir, 'no-data-feed'), { recursive: true });
  return { dir, env, debugPort, pairing: env.QM_PAIRING_FILE, data: env.QM_DATA_DIR ?? null };
}

function startApp(env) {
  const child = spawn(exe, [], { env, stdio: 'ignore' });
  const app = { pid: child.pid, exit: null };
  child.once('exit', (code) => (app.exit = code ?? -1));
  started.push(app);
  return app;
}

const readJson = (file) => {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
};

/** Waits for the pairing file, then checks the API and the SPA on its origin. Returns the origin and the node child. */
async function ready(app, scenario) {
  const pairing = await until(() => (app.exit !== null ? assert.fail(`the app exited with ${app.exit} before it was ready`) : readJson(scenario.pairing)), READY_LIMIT, 'the pairing file');
  assert.equal(pairing.format, 1);
  if (scenario.env.QM_PORT) assert.equal(pairing.origin, `http://127.0.0.1:${scenario.env.QM_PORT}`);
  const capabilities = await fetch(`${pairing.origin}/api/capabilities`, { signal: AbortSignal.timeout(10_000) });
  assert.equal(capabilities.status, 200);
  assert.equal((await capabilities.json()).login, 'none');
  const index = await fetch(`${pairing.origin}/`, { signal: AbortSignal.timeout(10_000) });
  assert.equal(index.status, 200);
  assert.match(await index.text(), /<div id="app"/);
  const nodes = childrenOf(app.pid).filter(isNode);
  assert.equal(nodes.length, 1, `the app has ${nodes.length} node children`);
  return { origin: pairing.origin, node: nodes[0].pid };
}

/** Both processes gone, the pairing file and the lock removed, within the limit. */
async function goneAndClean(app, node, scenario, what) {
  const start = Date.now();
  await until(() => app.exit !== null && !alive(node), EXIT_LIMIT, `${what}: the app and its server end`);
  await until(() => !existsSync(scenario.pairing), 2_000, `${what}: the pairing file is removed`);
  if (scenario.data) assert.ok(!existsSync(join(scenario.data, 'server.lock')), `${what}: server.lock is still there`);
  log(`${what}: app and server gone after ${((Date.now() - start) / 1000).toFixed(1)} s, pairing file and lock removed`);
}

// --- the page, through the webview's debugging port (WebView2) ---

class Page {
  static async open(debugPort, urlPrefix, limit = 30_000) {
    const target = await until(async () => {
      try {
        const list = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`, { signal: AbortSignal.timeout(2_000) })).json();
        return list.find((t) => t.type === 'page' && t.url.startsWith(urlPrefix));
      } catch {
        return null;
      }
    }, limit, `a page at ${urlPrefix} on the debugging port`);
    const page = new Page(new WebSocket(target.webSocketDebuggerUrl));
    await new Promise((resolve, reject) => {
      page.socket.addEventListener('open', resolve, { once: true });
      page.socket.addEventListener('error', () => reject(new Error('debugging socket failed')), { once: true });
    });
    return page;
  }

  constructor(socket) {
    this.socket = socket;
    this.next = 1;
    this.pending = new Map();
    this.console = [];
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      if (message.id) {
        this.pending.get(message.id)?.(message);
        this.pending.delete(message.id);
      } else if (message.method === 'Runtime.consoleAPICalled') {
        this.console.push(message.params.args.map((a) => a.value ?? a.description ?? '').join(' '));
      } else if (message.method === 'Log.entryAdded') {
        this.console.push(message.params.entry.text);
      }
    });
  }

  send(method, params = {}) {
    const id = this.next++;
    this.socket.send(JSON.stringify({ id, method, params }));
    return Promise.race([
      new Promise((resolve) => this.pending.set(id, resolve)).then((m) => (m.error ? Promise.reject(new Error(`${method}: ${m.error.message}`)) : m.result)),
      sleep(20_000).then(() => Promise.reject(new Error(`${method}: no answer in 20 s`))),
    ]);
  }

  /** Evaluates an expression (awaited) in the page; a rejection comes back as `{ rejected: text }`. */
  async eval(expression) {
    const wrapped = `(async () => { try { return { value: await (${expression}) }; } catch (e) { return { rejected: String(e?.message ?? e) }; } })()`;
    const result = await this.send('Runtime.evaluate', { expression: wrapped, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(`evaluate failed: ${result.exceptionDetails.text}`);
    return result.result.value;
  }

  /** `window.__TAURI__.core.invoke`: the resolved value; throws on a rejection. */
  async invoke(command, payload = {}) {
    const result = await this.eval(`window.__TAURI__.core.invoke(${JSON.stringify(command)}, ${JSON.stringify(payload)})`);
    if ('rejected' in result) throw new Error(`${command}: ${result.rejected}`);
    return result.value;
  }

  async rejects(command, payload = {}) {
    const result = await this.eval(`window.__TAURI__.core.invoke(${JSON.stringify(command)}, ${JSON.stringify(payload)})`);
    assert.ok('rejected' in result, `${command} was answered (${JSON.stringify(result.value)}), it must be refused`);
    return result.rejected;
  }

  close() {
    this.socket.close();
  }
}

// --- a local update feed ---

async function startFeed() {
  const feed = { files: new Map(), requests: [], hang: false };
  const server = createHttpServer((req, res) => {
    feed.requests.push(req.url);
    if (feed.hang) return; // never answered: the check's time limit has to end it
    const body = feed.files.get(req.url);
    if (body === undefined) return void res.writeHead(404).end('not found');
    res.writeHead(200, { 'content-type': req.url.endsWith('.json') ? 'application/json' : 'application/octet-stream', 'content-length': Buffer.byteLength(body) }).end(body);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  feed.url = `http://127.0.0.1:${server.address().port}`;
  feed.close = () => new Promise((resolve) => {
    server.closeAllConnections();
    server.close(resolve);
  });
  feed.reset = () => {
    feed.files.clear();
    feed.requests.length = 0;
    feed.hang = false;
  };
  /** Publishes a release: `latest.json` in Tauri's format and an "installer" whose signature cannot be valid. */
  feed.release = (tag, version, notes) => {
    const target = `${windows ? 'windows' : 'linux'}-${process.arch === 'arm64' ? 'aarch64' : 'x86_64'}`;
    const entry = { signature: Buffer.from('untrusted comment: not a signature\nAAAA\n').toString('base64'), url: `${feed.url}/${tag}/setup.bin` };
    feed.files.set(`/${tag}/latest.json`, JSON.stringify({ version, notes, pub_date: '2026-01-01T00:00:00Z', platforms: { [target]: entry } }));
    feed.files.set(`/${tag}/setup.bin`, Buffer.alloc(3 * 1024 * 1024, 7));
  };
  return feed;
}

// --- the scenarios ---

/** Start, API, a node child, no update request with the switch off, a close request, everything gone and removed. */
async function lifecycle(feed) {
  const scenario = await scenarioEnv('lifecycle', feed);
  const begun = Date.now();
  const app = startApp(scenario.env);
  const { origin, node } = await ready(app, scenario);
  log(`lifecycle: ready at ${origin} after ${((Date.now() - begun) / 1000).toFixed(1)} s (first start: the database is created), node child ${node}`);
  assert.ok(existsSync(join(scenario.data, 'server.lock')), 'server.lock while running');
  const others = childrenOf(app.pid).filter((p) => !isNode(p)).map((p) => p.name);
  log(`lifecycle: the app's other children: ${[...new Set(others)].join(', ') || 'none'}`);
  await sleep(1_500);
  assert.deepEqual(feed.requests, [], 'with QM_AUTO_UPDATE=0 the shell asks nothing');
  requestClose(app.pid);
  await goneAndClean(app, node, scenario, 'lifecycle: close request');
}

/** The app killed: the server ends by itself; app and server killed: the next start takes over the stale lock. */
async function hardKill(feed) {
  const scenario = await scenarioEnv('hardkill', feed);
  let app = startApp(scenario.env);
  let { node } = await ready(app, scenario);
  killHard(app.pid, false);
  const start = Date.now();
  await until(() => app.exit !== null && !alive(node), EXIT_LIMIT, 'hard kill: the server ends by itself when the app is killed');
  const lock = join(scenario.data, 'server.lock');
  log(`hard kill: app killed, the server ended by itself after ${((Date.now() - start) / 1000).toFixed(1)} s (lock ${existsSync(lock) ? 'left' : 'removed'}, pairing file ${existsSync(scenario.pairing) ? 'left' : 'removed'})`);

  app = startApp(scenario.env);
  ({ node } = await ready(app, scenario));
  // Both at once: nothing can clean up, the lock and the pairing file stay
  killHard(app.pid, true);
  await until(() => app.exit !== null && !alive(node), EXIT_LIMIT, 'hard kill: app and server are killed');
  assert.ok(existsSync(lock), 'a killed server leaves its lock');
  rmSync(scenario.pairing, { force: true });

  app = startApp(scenario.env);
  ({ node } = await ready(app, scenario));
  log('hard kill: the next start took over the stale lock');
  requestClose(app.pid);
  await goneAndClean(app, node, scenario, 'hard kill: close request after the takeover');
}

/** The shell contract from the web app's page: every command but the pickers, the event, the updater, the refusals. */
async function contract(feed) {
  const scenario = await scenarioEnv('contract', feed);
  const app = startApp(scenario.env);
  const { origin, node } = await ready(app, scenario);
  const page = await Page.open(scenario.debugPort, origin);
  try {
    // The page's own start, watched from the first script on: does Tauri's IPC get through the web app's CSP?
    await page.send('Runtime.enable');
    await page.send('Log.enable');
    await page.send('Page.enable');
    page.console.length = 0;
    await page.send('Page.reload');
    await until(async () => (await page.eval('document.readyState === "complete" && typeof window.__TAURI__?.core?.invoke === "function"')).value === true, 20_000, 'the reloaded page with the global');
    assert.equal(await page.invoke('window_is_maximized'), false);
    await sleep(1_000);
    const blocked = page.console.filter((line) => /IPC custom protocol failed|Content Security Policy|Refused to connect/i.test(line));
    assert.deepEqual(blocked, [], 'the IPC must not be blocked by the page\'s CSP');
    const csp = (await page.eval(`fetch(location.href).then((r) => r.headers.get('content-security-policy'))`)).value;
    assert.match(csp, /connect-src 'self' ws:\/\/127\.0\.0\.1:\d+ \S+(;|$)/, `connect-src has exactly one extra source: ${csp}`);
    log(`contract: IPC through the custom protocol, no CSP report; ${/connect-src[^;]*/.exec(csp)[0]}`);

    // The window
    await page.invoke('window_toggle_maximize');
    await until(() => page.invoke('window_is_maximized'), 5_000, 'maximized after the toggle');
    await page.invoke('window_toggle_maximize');
    await until(async () => !(await page.invoke('window_is_maximized')), 5_000, 'restored after the second toggle');
    assert.match(await page.rejects('window_start_resize', { direction: 'Sideways' }), /direction|variant/i);

    // The updater: idle and silent with the switch off, then a check against an empty feed
    const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
    assert.deepEqual(await page.invoke('update_state'), { state: 'idle', current: version, available: null, notes: null, progress: null, error: null, channel: 'stable', channels: ['stable'] });
    assert.deepEqual(feed.requests, [], 'nothing was asked before a click');
    assert.equal((await page.eval(`window.__TAURI__.event.listen('update-changed', (e) => (window.__qmStates ??= []).push(e.payload)).then(() => true)`)).value, true);
    const states = async () => (await page.eval('(window.__qmStates ?? []).map((s) => s.state)')).value;
    const settled = (...final) => until(async () => final.includes((await page.invoke('update_state')).state), 30_000, `update state ${final.join(' or ')}`);
    await page.invoke('update_check');
    await settled('current');
    assert.deepEqual(feed.requests, ['/channels.json'], 'no channels.json: one request, no update, no error');
    assert.deepEqual(await states(), ['checking', 'checking', 'current']);

    // A release on stable and one on a channel
    feed.release('app-v99.0.0', '99.0.0', 'Smoke test notes.');
    feed.release('app-v0.0.1-beta.1', '0.0.1-beta.1', 'Channel notes.');
    feed.files.set('/channels.json', JSON.stringify({ app: { stable: 'app-v99.0.0', channels: [{ id: 'beta', tag: 'app-v0.0.1-beta.1' }] }, data: { stable: 'data-1-1' } }));
    await page.invoke('update_check');
    const found = await page.invoke('update_state').then(() => settled('available', 'error')).then(() => page.invoke('update_state'));
    assert.deepEqual(found.channels, ['stable', 'beta']);
    if (found.state === 'error') {
      // A build that is not the installer's (target/fast): it only compares versions
      assert.match(found.error, /99\.0\.0/);
      log(`contract: this build has no updater: "${found.error}"`);
    } else {
      assert.deepEqual({ available: found.available, notes: found.notes, channel: found.channel }, { available: '99.0.0', notes: 'Smoke test notes.', channel: 'stable' });
      // The download runs, the signature is not ours: nothing is installed, the app keeps running
      await page.eval('window.__qmStates = []');
      await page.invoke('update_install');
      const failed = await settled('error').then(() => page.invoke('update_state'));
      assert.ok(feed.requests.includes('/app-v99.0.0/setup.bin'), 'the download was requested');
      assert.ok((await states()).includes('downloading'), 'the download was reported');
      const progress = (await page.eval('(window.__qmStates ?? []).filter((s) => s.state === "downloading" && s.progress !== null).length')).value;
      log(`contract: update found, downloaded (${progress} progress events) and refused: "${failed.error}"`);
      assert.equal((await fetch(`${origin}/api/capabilities`)).status, 200, 'the server still runs after a refused update');

      // A channel: saved, checked at once, a lower version is offered right after the switch
      await page.invoke('update_set_channel', { id: 'beta' });
      const beta = await settled('available', 'error').then(() => page.invoke('update_state'));
      assert.deepEqual({ state: beta.state, available: beta.available, channel: beta.channel }, { state: 'available', available: '0.0.1-beta.1', channel: 'beta' });
      assert.deepEqual(readJson(scenario.env.QM_APP_CONFIG), { updateChannel: 'beta' });
      // The channel vanished: back to stable
      feed.files.set('/channels.json', JSON.stringify({ app: { stable: 'app-v99.0.0' } }));
      await page.invoke('update_check');
      const back = await settled('available', 'error').then(() => page.invoke('update_state'));
      assert.deepEqual({ available: back.available, channel: back.channel, channels: back.channels }, { available: '99.0.0', channel: 'stable', channels: ['stable'] });
    }
    assert.match(await page.rejects('update_set_channel', { id: '../x' }), /not a channel/);

    // Refused: the splash's own commands, any plugin command the capability does not list
    await page.rejects('splash_state');
    await page.rejects('quit');
    await page.rejects('plugin:window|set_title', { label: 'main', value: 'x' });
    await page.rejects('plugin:updater|check');
    await page.rejects('plugin:dialog|open', { options: {} });
    // Granted for the title bar: the drag region's double click
    assert.equal((await page.eval(`window.__TAURI__.core.invoke('plugin:window|internal_toggle_maximize', { label: 'main' }).then(() => true)`)).value, true);
    await until(() => page.invoke('window_is_maximized'), 5_000, 'maximized by the drag region\'s command');
    log('contract: window commands, update state and event, channel, refusals: ok');

    // The window's close button, with the window minimized
    await page.invoke('window_minimize');
    await page.eval(`void window.__TAURI__.core.invoke('window_close')`);
  } finally {
    page.close();
  }
  await goneAndClean(app, node, scenario, 'contract: window_close');
}

/** A second app on the same data folder: the splash says so and offers Quit; the first app is not touched. */
async function locked(feed) {
  const first = await scenarioEnv('locked', feed);
  const app = startApp(first.env);
  const { origin, node } = await ready(app, first);
  const second = await scenarioEnv('locked-second', feed, { QM_DATA_DIR: first.data, QM_PAIRING_FILE: first.pairing });
  const other = startApp(second.env);
  const page = await Page.open(second.debugPort, windows ? 'http://tauri.localhost' : 'tauri://localhost');
  try {
    const shown = await until(async () => {
      const state = (await page.eval(`({ sentence: document.getElementById('sentence').textContent, quit: document.getElementById('quit').textContent, failed: !document.getElementById('failed').classList.contains('hidden'), steps: document.getElementById('steps').classList.contains('hidden'), version: document.getElementById('version').textContent, font: document.fonts.check('700 40px "Bai Jamjuree"') })`)).value;
      return state?.failed ? state : null;
    }, 30_000, 'the splash shows the failure');
    assert.ok(['Quartermaster läuft bereits.', 'Quartermaster is already running.'].includes(shown.sentence), shown.sentence);
    assert.ok(['Beenden', 'Quit'].includes(shown.quit), shown.quit);
    assert.equal(shown.steps, true, 'the segments are hidden in the failed state');
    assert.match(shown.version, /^v\d+\.\d+\.\d+/);
    assert.equal(shown.font, true, 'the splash loaded its font');
    // The web app's commands are not the splash's
    await page.rejects('update_state');
    await page.rejects('pick_file', { extensions: [] });
    assert.equal(childrenOf(other.pid).filter(isNode).length, 0, 'the refused server has ended');
    assert.equal((await fetch(`${origin}/api/capabilities`)).status, 200, 'the first app still answers');
    log(`locked: the second app shows "${shown.sentence}" with the button "${shown.quit}"`);
    await page.eval(`void document.getElementById('quit').click()`);
  } finally {
    page.close();
  }
  await until(() => other.exit !== null, EXIT_LIMIT, 'locked: the second app quits by its button');
  assert.ok(alive(node) && app.exit === null, 'the first app and its server still run');
  requestClose(app.pid);
  await goneAndClean(app, node, first, 'locked: close request to the first app');
}

/** Without QM_DATA_DIR the app is a single instance: a second start ends at once and the first keeps running. */
async function singleInstance(feed) {
  const profile = join(work, 'single', 'profile');
  mkdirSync(profile, { recursive: true });
  // The default data folder, moved under the temp folder (the server and the shell read LOCALAPPDATA / XDG_DATA_HOME)
  const scenario = await scenarioEnv('single', feed, { QM_DATA_DIR: undefined, LOCALAPPDATA: profile, XDG_DATA_HOME: profile });
  scenario.data = windows ? join(profile, 'QuarterMaster', 'singleuser') : join(profile, 'quartermaster', 'singleuser');
  const app = startApp(scenario.env);
  const { origin, node } = await ready(app, scenario).catch((e) => {
    throw new Error(`${e.message} (is another Quartermaster running? the single instance then ends this one)`);
  });
  assert.ok(existsSync(join(scenario.data, 'server.lock')), 'the data folder is the one under the temp profile');
  const second = startApp(scenario.env);
  await until(() => second.exit !== null, EXIT_LIMIT, 'single instance: the second start ends');
  assert.equal(second.exit, 0);
  assert.ok(app.exit === null && alive(node), 'the first app and its server still run');
  assert.equal(processes().filter((p) => isNode(p) && p.ppid === second.pid).length, 0, 'the second start left no server');
  assert.equal((await fetch(`${origin}/api/capabilities`)).status, 200);
  log('single instance: the second start ended with 0, the first app still answers');
  requestClose(app.pid);
  await goneAndClean(app, node, scenario, 'single instance: close request');
}

/** "Updates automatisch" on: the start asks the feed first; an update that cannot be installed and a feed that never answers both let the app start. */
async function startUpdate(feed) {
  // 1. An update is there, its signature is not ours: found, downloaded, refused, then the normal start
  feed.release('app-v99.0.0', '99.0.0', 'Smoke test notes.');
  feed.files.set('/channels.json', JSON.stringify({ app: { stable: 'app-v99.0.0' } }));
  let scenario = await scenarioEnv('start-update', feed, { QM_AUTO_UPDATE: undefined });
  let app = startApp(scenario.env);
  let { origin, node } = await ready(app, scenario);
  let page = await Page.open(scenario.debugPort, origin);
  const state = await page.invoke('update_state');
  page.close();
  if (state.state === 'error' && /99\.0\.0/.test(state.error ?? '')) {
    log(`start update: this build has no updater: "${state.error}"`);
    assert.deepEqual(feed.requests, ['/channels.json', '/app-v99.0.0/latest.json']);
  } else {
    assert.deepEqual(feed.requests, ['/channels.json', '/app-v99.0.0/latest.json', '/app-v99.0.0/setup.bin'], 'the start checked, and downloaded the update at once');
    assert.equal(state.state, 'error', `the refused update is the updater's error: ${JSON.stringify(state)}`);
    log(`start update: found, downloaded and refused at start ("${state.error}"), then the app started normally`);
  }
  requestClose(app.pid);
  await goneAndClean(app, node, scenario, 'start update: close request');

  // 2. The feed never answers: the start goes on after the check's limit
  feed.reset();
  feed.hang = true;
  scenario = await scenarioEnv('start-update-hang', feed, { QM_AUTO_UPDATE: undefined });
  const begun = Date.now();
  app = startApp(scenario.env);
  ({ origin, node } = await ready(app, scenario));
  const took = (Date.now() - begun) / 1000;
  assert.deepEqual(feed.requests, ['/channels.json']);
  assert.ok(took > 4.5 && took < 40, `ready after ${took.toFixed(1)} s`);
  page = await Page.open(scenario.debugPort, origin);
  assert.equal((await page.invoke('update_state')).state, 'idle', 'a given-up check leaves the updater idle');
  page.close();
  log(`start update: a feed that never answers held the start for the limit only (ready after ${took.toFixed(1)} s)`);
  requestClose(app.pid);
  await goneAndClean(app, node, scenario, 'start update (no answer): close request');

  // 3. The switch off in the settings file: nothing is asked
  feed.reset();
  scenario = await scenarioEnv('start-update-off', feed, { QM_AUTO_UPDATE: undefined });
  mkdirSync(scenario.data, { recursive: true });
  writeFileSync(join(scenario.data, 'settings.json'), JSON.stringify({ autoUpdate: false }));
  app = startApp(scenario.env);
  ({ node } = await ready(app, scenario));
  await sleep(1_000);
  assert.deepEqual(feed.requests, [], 'autoUpdate false in settings.json: no request');
  log('start update: with autoUpdate false in settings.json nothing was asked');
  requestClose(app.pid);
  await goneAndClean(app, node, scenario, 'start update (off): close request');
}

// --- run ---

const scenarios = { lifecycle, hardKill, contract, locked, singleInstance, startUpdate };

let failed = false;
const watchdog = { timer: null };
try {
  if (!args.includes('--no-build')) {
    log('building (pnpm app:build)');
    const begun = Date.now();
    execSync('pnpm app:build', { cwd: root, stdio: 'inherit', timeout: BUILD_LIMIT });
    log(`built in ${((Date.now() - begun) / 60_000).toFixed(1)} min`);
  }
  for (const file of [exe, join(exe, '..', windows ? 'node.exe' : 'node'), join(exe, '..', 'server', 'bundle.json')]) assert.ok(existsSync(file), `${file} is missing`);
  log(`app: ${exe}`);
  watchdog.timer = setTimeout(() => {
    console.error(`[smoke] FAILED: not finished after ${RUN_LIMIT / 60_000} min`);
    cleanup();
    process.exit(1);
  }, RUN_LIMIT);
  const feed = await startFeed();
  try {
    for (const [name, run] of Object.entries(scenarios)) {
      if (only && !only.includes(name)) continue;
      feed.reset();
      await run(feed);
    }
  } finally {
    await feed.close();
  }
  log('all scenarios passed');
} catch (err) {
  failed = true;
  console.error(`[smoke] FAILED: ${err?.stack ?? err}`);
} finally {
  clearTimeout(watchdog.timer);
  cleanup();
}
process.exit(failed ? 1 : 0);

/** Whatever happened: nothing started here keeps running, and the temp folder goes. */
function cleanup() {
  for (const app of started) {
    if (app.exit === null) {
      log(`cleanup: killing process ${app.pid} and its children`);
      killHard(app.pid, true);
    }
  }
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      rmSync(work, { recursive: true, force: true });
      break;
    } catch {
      spawnSync(process.execPath, ['-e', 'setTimeout(() => {}, 250)']);
    }
  }
}
