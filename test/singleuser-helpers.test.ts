import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { cspConnect, dataDir, dbDir, thumbsDir } from '../src/singleuser/paths.ts';
import { PORT_FIRST, PORT_LAST, canListen, choosePort } from '../src/singleuser/port.ts';

describe('singleuser: data folder', () => {
  it('QM_DATA_DIR wins on every platform', () => {
    assert.equal(dataDir({ QM_DATA_DIR: 'X:\\data', LOCALAPPDATA: 'C:\\L' }, 'win32', 'C:\\Users\\u'), 'X:\\data');
    assert.equal(dataDir({ QM_DATA_DIR: '/x', XDG_DATA_HOME: '/y' }, 'linux', '/home/u'), '/x');
  });
  it('Windows: %LOCALAPPDATA%\\QuarterMaster\\singleuser, the profile when it is unset', () => {
    assert.equal(dataDir({ LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' }, 'win32', 'C:\\Users\\u'), 'C:\\Users\\u\\AppData\\Local\\QuarterMaster\\singleuser');
    assert.equal(dataDir({}, 'win32', 'C:\\Users\\u'), 'C:\\Users\\u\\AppData\\Local\\QuarterMaster\\singleuser');
  });
  it('Linux: XDG_DATA_HOME or ~/.local/share, lower case', () => {
    assert.equal(dataDir({ XDG_DATA_HOME: '/xdg' }, 'linux', '/home/u'), '/xdg/quartermaster/singleuser');
    assert.equal(dataDir({}, 'linux', '/home/u'), '/home/u/.local/share/quartermaster/singleuser');
    assert.equal(dataDir({ XDG_DATA_HOME: '' }, 'linux', '/home/u'), '/home/u/.local/share/quartermaster/singleuser');
  });
  it('the database and thumbnail folders live inside; QM_THUMBS_DIR overrides the thumbnails', () => {
    assert.equal(dbDir('/d'), join('/d', 'db'));
    assert.equal(thumbsDir({}, '/d'), join('/d', 'thumbs'));
    assert.equal(thumbsDir({ QM_THUMBS_DIR: '/elsewhere' }, '/d'), '/elsewhere');
    assert.equal(thumbsDir({ QM_THUMBS_DIR: '' }, '/d'), join('/d', 'thumbs'));
  });
});

describe('singleuser: port', () => {
  const taken = (...ports: number[]) => async (p: number) => !ports.includes(p);
  it('the first free port of the range', async () => {
    assert.equal(await choosePort({}, taken()), PORT_FIRST);
    assert.equal(await choosePort({}, taken(28460, 28461)), 28462);
    assert.equal(await choosePort({}, taken(28460, 28461, 28462, 28463, 28464, 28465, 28466, 28467, 28468)), PORT_LAST);
  });
  it('none free: a clear error', async () => {
    const all = Array.from({ length: PORT_LAST - PORT_FIRST + 1 }, (_, i) => PORT_FIRST + i);
    await assert.rejects(choosePort({}, taken(...all)), /No free port.*28460-28469/);
  });
  it('QM_PORT: exactly that one, or an error', async () => {
    assert.equal(await choosePort({ QM_PORT: '4711' }, taken()), 4711);
    assert.equal(await choosePort({ QM_PORT: '' }, taken()), PORT_FIRST);
    await assert.rejects(choosePort({ QM_PORT: '4711' }, taken(4711)), /Port 4711 .*in use/);
    for (const bad of ['abc', '0', '70000', '1.5']) await assert.rejects(choosePort({ QM_PORT: bad }, taken()), /QM_PORT must be/);
  });
  it('canListen really tries: a taken port is not free, a closed one is', async () => {
    const blocker = createServer();
    await new Promise<void>((r) => blocker.listen(0, '127.0.0.1', r));
    const { port } = blocker.address() as { port: number };
    try {
      assert.equal(await canListen(port), false);
      assert.equal(await choosePort({ QM_PORT: String(port) }).catch(() => 'refused'), 'refused');
    } finally {
      await new Promise((r) => blocker.close(r));
    }
    assert.equal(await canListen(port), true);
  });
});

describe('singleuser: QM_CSP_CONNECT', () => {
  it('is nothing when unset or blank, else the sources split at spaces and commas', () => {
    assert.deepEqual(cspConnect(undefined), []);
    assert.deepEqual(cspConnect('  '), []);
    assert.deepEqual(cspConnect('ipc: http://ipc.localhost,http://127.0.0.1:1430  ws://[::1]:5'), ['ipc:', 'http://ipc.localhost', 'http://127.0.0.1:1430', 'ws://[::1]:5']);
  });
  it('refuses anything that could end the directive or add another one', () => {
    for (const bad of ["'unsafe-inline'", 'a;script-src', 'https://x"y', 'x<y', 'ipc: *; default-src *']) assert.throws(() => cspConnect(bad), /QM_CSP_CONNECT/, bad);
  });
});
