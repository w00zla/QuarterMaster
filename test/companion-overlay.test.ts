// The companion's scan overlay: how many rows its fixed tile shows per display (companion/src/overlayLayout.ts,
// the heights in overlay.rs).
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { overlayLayout } from '../companion/src/overlayLayout.ts';

describe('companion overlay layout', () => {
  it('compact: 5 rows in every mode, no top row', () => {
    assert.deepEqual(overlayLayout('compact', false), { top: false, rows: 5 });
    assert.deepEqual(overlayLayout('compact', true), { top: false, rows: 5 });
  });

  it('thumbnails: the latest item as the top row and 5 rows; the refinery rows only', () => {
    assert.deepEqual(overlayLayout('thumbs', false), { top: true, rows: 5 });
    assert.deepEqual(overlayLayout('thumbs', true), { top: false, rows: 8 });
  });

  it('fits the tile: 22 px location line, 60 px top row, 20 px rows, 4 px padding, 2 px border', () => {
    const height = (display: 'thumbs' | 'compact', refinery: boolean) => {
      const l = overlayLayout(display, refinery);
      return 2 + 22 + 4 + (l.top ? 60 : 0) + l.rows * 20;
    };
    assert.ok(height('compact', false) <= 130);
    assert.ok(height('thumbs', false) <= 190);
    assert.ok(height('thumbs', true) <= 190);
  });
});
