import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseSideMode, SIDE_WIDE_FROM, sideModeFor, WINDOW_MIN } from '../companion/src/sideTabs.ts';

test('thresholds: the window keeps the tables 640 px wide with the narrow panel', () => {
  assert.equal(WINDOW_MIN, 696);
  assert.equal(SIDE_WIDE_FROM, 840);
});

test('parseSideMode: narrow unless "wide" is stored', () => {
  assert.equal(parseSideMode(null), 'narrow');
  assert.equal(parseSideMode('garbage'), 'narrow');
  assert.equal(parseSideMode('narrow'), 'narrow');
  assert.equal(parseSideMode('wide'), 'wide');
});

test('sideModeFor: narrow below 840 px whatever the choice', () => {
  assert.equal(sideModeFor('wide', 839), 'narrow');
  assert.equal(sideModeFor('wide', 840), 'wide');
  assert.equal(sideModeFor('narrow', 2000), 'narrow');
});
