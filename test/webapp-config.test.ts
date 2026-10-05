// User web app: settings check and rate limit keys (pure).
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { loadConfig } from '../src/webapp/config.ts';
import { rateKey } from '../src/webapp/ip.ts';

const base = { DISCORD_APP_ID: '1', DISCORD_CLIENT_SECRET: 's' };

describe('web app config', () => {
  it('accepts localhost over http without a proxy setting', () => {
    const c = loadConfig({ ...base, WEBAPP_ORIGIN: 'http://localhost:5174/' });
    assert.equal(c.origin, 'http://localhost:5174');
    assert.equal(c.trustProxy, false);
  });

  it('refuses plain http for a public origin and a public origin without WEBAPP_TRUST_PROXY', () => {
    assert.throws(() => loadConfig({ ...base, WEBAPP_ORIGIN: 'http://qm.example.com' }), /https/);
    assert.throws(() => loadConfig({ ...base, WEBAPP_ORIGIN: 'https://qm.example.com' }), /WEBAPP_TRUST_PROXY/);
    assert.throws(() => loadConfig({ ...base, WEBAPP_ORIGIN: 'https://qm.example.com', WEBAPP_TRUST_PROXY: 'yes' }), /WEBAPP_TRUST_PROXY/);
    assert.equal(loadConfig({ ...base, WEBAPP_ORIGIN: 'https://qm.example.com', WEBAPP_TRUST_PROXY: '1' }).trustProxy, true);
    assert.equal(loadConfig({ ...base, WEBAPP_ORIGIN: 'https://qm.example.com', WEBAPP_TRUST_PROXY: '0' }).trustProxy, false);
  });

  it('needs the Discord settings', () => {
    assert.throws(() => loadConfig({ WEBAPP_ORIGIN: 'http://localhost:5174' }), /DISCORD_CLIENT_SECRET/);
  });
});

describe('rate limit keys', () => {
  it('keeps IPv4, maps IPv4-mapped IPv6 to IPv4', () => {
    assert.equal(rateKey('203.0.113.7'), '203.0.113.7');
    assert.equal(rateKey('::ffff:203.0.113.7'), '203.0.113.7');
  });

  it('groups IPv6 by /64', () => {
    const key = '2001:db8:1:2::/64';
    for (const ip of ['2001:db8:1:2::1', '2001:0db8:0001:0002:ffff:0:0:1', '2001:DB8:1:2:a:b:c:d', '2001:db8:1:2::5%eth0']) {
      assert.equal(rateKey(ip), key, ip);
    }
    assert.notEqual(rateKey('2001:db8:1:3::1'), key);
    assert.equal(rateKey('::1'), '0:0:0:0::/64');
  });

  it('leaves unparsable input as it is', () => {
    for (const ip of ['unknown', '1::2::3', '1:2:3']) assert.equal(rateKey(ip), ip);
  });
});
