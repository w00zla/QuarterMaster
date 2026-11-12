import assert from 'node:assert/strict';
import { test } from 'node:test';
import { minWidthFor, parseSideMode, WINDOW_MIN, WINDOW_MIN_WIDE } from '../companion/src/sideTabs.ts';

test('thresholds: the window keeps the tables 640 px wide with either panel', () => {
  assert.equal(WINDOW_MIN, 696);
  assert.equal(WINDOW_MIN_WIDE, 840);
});

test('parseSideMode: narrow unless "wide" is stored', () => {
  assert.equal(parseSideMode(null), 'narrow');
  assert.equal(parseSideMode('garbage'), 'narrow');
  assert.equal(parseSideMode('narrow'), 'narrow');
  assert.equal(parseSideMode('wide'), 'wide');
});

test('minWidthFor: the window minimum per mode', () => {
  assert.equal(minWidthFor('narrow'), 696);
  assert.equal(minWidthFor('wide'), 840);
});
