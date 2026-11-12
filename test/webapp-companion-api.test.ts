// The companion API contract's numbers and the global.ini text writer (no database).
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseGlobalIni } from '../src/catalog/extract/localization.ts';
import { COMPANION_API, COMPANION_API_MIN } from '../src/webapp/api-types.ts';
import { iniText } from '../src/webapp/locale.ts';

describe('companion API numbers', () => {
  it('the minimum is a positive whole number, never above the maximum', () => {
    assert.ok(Number.isInteger(COMPANION_API) && Number.isInteger(COMPANION_API_MIN));
    assert.ok(COMPANION_API_MIN >= 1);
    assert.ok(COMPANION_API_MIN <= COMPANION_API);
  });
});

describe('iniText', () => {
  it('writes key=value lines, line breaks as the literal \\n, values with = and keys as they are', () => {
    const text = iniText([
      { key: 'a', value: 'one' }, { key: 'b,P', value: 'x=y' }, { key: 'c', value: 'l1\nl2\n\nl4' }, { key: 'd', value: 'crlf\r\nend' },
    ]);
    assert.equal(text, 'a=one\nb,P=x=y\nc=l1\\nl2\\n\\nl4\nd=crlf\\nend\n');
    assert.equal(iniText([]), '');
  });

  it('round-trips through the game\'s own file parser', () => {
    const texts = [{ key: 'k1', value: 'multi\nline' }, { key: 'k2', value: 'a=b' }];
    const parsed = parseGlobalIni(iniText(texts));
    assert.deepEqual(Object.fromEntries(parsed), { k1: 'multi\\nline', k2: 'a=b' });
  });
});
