// Runs against TEST_DATABASE_URL only; the web, bot, app and catalog schemas there are dropped and recreated.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { type Db } from '../src/db/client.ts';
import { connectAs, prepareDb } from './roles.ts';
import { pickQuote } from '../src/bot/status.ts';
import {
  addStatusQuote, deleteStatusQuote, getStatusQuotes, quoteText, updateStatusQuote,
} from '../src/adminapp/status-quotes.ts';

const url = process.env.TEST_DATABASE_URL;

describe('quoteText', () => {
  it('trims and checks Discord\'s 128 characters (code points)', () => {
    assert.equal(quoteText('  o7  '), 'o7');
    assert.equal(quoteText('   '), null);
    assert.equal(quoteText(42), null);
    assert.equal(quoteText('x'.repeat(128)), 'x'.repeat(128));
    assert.equal(quoteText('x'.repeat(129)), null);
    assert.equal(quoteText('🚀'.repeat(128)), '🚀'.repeat(128));
  });
});

describe('bot status texts (database)', { skip: url ? false : 'TEST_DATABASE_URL not set' }, () => {
  let db: Db;
  let close: () => Promise<void>;

  before(async () => {
    await prepareDb(url);
    ({ db, close } = connectAs(url, 'qm_app'));
  });
  after(async () => close?.());

  it('picks nothing without texts', async () => {
    assert.equal(await pickQuote(db, null), null);
  });

  it('adds, changes and deletes texts', async () => {
    const a = await addStatusQuote(db, 'Fly safe');
    const b = await addStatusQuote(db, '🚀'.repeat(128));
    assert.deepEqual((await getStatusQuotes(db)).map((q) => q.text), ['Fly safe', '🚀'.repeat(128)]);
    assert.equal((await updateStatusQuote(db, a.id, 'o7'))?.text, 'o7');
    assert.equal(await updateStatusQuote(db, 999_999, 'x'), null);
    assert.equal(await deleteStatusQuote(db, b.id), true);
    assert.equal(await deleteStatusQuote(db, b.id), false);
    assert.deepEqual((await getStatusQuotes(db)).map((q) => q.text), ['o7']);
    await assert.rejects(addStatusQuote(db, 'x'.repeat(129)));
  });

  it('never picks the last text twice in a row, unless it is the only one', async () => {
    const [only] = await getStatusQuotes(db);
    assert.equal((await pickQuote(db, only!.id))?.id, only!.id);
    const other = await addStatusQuote(db, 'Fly safe');
    for (let i = 0; i < 20; i++) assert.equal((await pickQuote(db, only!.id))?.id, other.id);
  });
});
