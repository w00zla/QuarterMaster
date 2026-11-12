// The companion's scan overlay: how many rows its fixed tile shows per display (src/overlayLayout.ts,
// the heights in overlay.rs).
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { overlayLayout } from '../companion/src/overlayLayout.ts';

describe('companion overlay layout', () => {
  it('compact: 6 rows in every mode, no top row', () => {
    assert.deepEqual(overlayLayout('compact', false), { top: false, rows: 6 });
    assert.deepEqual(overlayLayout('compact', true), { top: false, rows: 6 });
  });

  it('thumbnails: the latest item as the top row and 6 rows; the refinery and the signatures rows only', () => {
    assert.deepEqual(overlayLayout('thumbs', false), { top: true, rows: 6 });
    assert.deepEqual(overlayLayout('thumbs', true), { top: false, rows: 9 });
  });

  it('fits the tile: 22 px location line, 60 px top row, 20 px rows, 4 px padding, 2 px border', () => {
    const height = (display: 'thumbs' | 'compact', rowsOnly: boolean) => {
      const l = overlayLayout(display, rowsOnly);
      return 2 + 22 + 4 + (l.top ? 60 : 0) + l.rows * 20;
    };
    assert.ok(height('compact', false) <= 150);
    assert.ok(height('thumbs', false) <= 210);
    assert.ok(height('thumbs', true) <= 210);
  });
});
