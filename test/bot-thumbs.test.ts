// The bot's thumbnail URLs: where Discord fetches them from and which UUIDs have one.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ContainerBuilder } from 'discord.js';
import { addHead, thumbsBase, thumbUrlOf } from '../src/bot/thumbs.ts';

const UUID = '0a1b2c3d-0000-4000-8000-00000000abcd';

describe('bot thumbnails', () => {
  it('takes THUMBS_URL, else the web app\'s /thumbs on a public origin, else none', () => {
    assert.equal(thumbsBase({ THUMBS_URL: 'https://cdn.example/qm/thumbs/' }), 'https://cdn.example/qm/thumbs');
    assert.equal(thumbsBase({ THUMBS_URL: 'https://cdn.example/t', WEBAPP_ORIGIN: 'https://qm.example' }), 'https://cdn.example/t');
    assert.equal(thumbsBase({ THUMBS_URL: 'https://cdn.example/t', WEBAPP_ORIGIN: 'http://localhost:5174' }), 'https://cdn.example/t');
    assert.equal(thumbsBase({ WEBAPP_ORIGIN: 'https://qm.example/' }), 'https://qm.example/thumbs');
    for (const local of ['http://localhost:5174', 'http://127.0.0.1:3002', 'http://[::1]:3002']) {
      assert.equal(thumbsBase({ WEBAPP_ORIGIN: local }), null, local);
    }
    assert.equal(thumbsBase({}), null);
    assert.equal(thumbsBase({ THUMBS_URL: ' ', WEBAPP_ORIGIN: '' }), null);
    assert.equal(thumbsBase({ WEBAPP_ORIGIN: 'not a url' }), null);
  });

  it('builds the large file\'s URL for UUIDs in the index only', () => {
    const index = new Map([[UUID, 'deadbeef']]);
    assert.equal(thumbUrlOf('https://qm.example/thumbs', index, UUID), `https://qm.example/thumbs/l/${UUID}.deadbeef.avif`);
    assert.equal(thumbUrlOf('https://qm.example/thumbs', index, UUID.toUpperCase()), `https://qm.example/thumbs/l/${UUID}.deadbeef.avif`);
    assert.equal(thumbUrlOf('https://qm.example/thumbs', index, '0a1b2c3d-0000-4000-8000-000000000000'), null);
    assert.equal(thumbUrlOf('https://qm.example/thumbs', index, null), null);
    assert.equal(thumbUrlOf(null, index, UUID), null);
  });

  it('puts the head beside the thumbnail, or alone without one', () => {
    const types = (c: ContainerBuilder) => (c.toJSON().components as { type: number }[]).map((x) => x.type);
    assert.deepEqual(types(addHead(new ContainerBuilder(), 'Head', 'https://x/l/a.avif')), [9]);
    assert.deepEqual(types(addHead(new ContainerBuilder(), 'Head', null)), [10]);
  });
});
