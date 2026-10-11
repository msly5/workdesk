import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectorBounds, clampInspectorWidth } from '../public/inspector.js';

test('desktop panel leaves a usable canvas and keeps widths inside bounds', () => {
  const bounds = inspectorBounds(1440, 248);
  assert.equal(1440 - 248 - bounds.max, 360);
  assert.equal(clampInspectorWidth(10000, bounds), bounds.max);
  assert.equal(clampInspectorWidth(-20, bounds), bounds.min);
  assert.equal(clampInspectorWidth(580, bounds), 580);
  assert.equal(clampInspectorWidth(NaN, bounds), 420);
});

test('narrow viewports never produce a panel wider than the screen', () => {
  for (const width of [240, 320, 390, 600, 768, 1024]) {
    const bounds = inspectorBounds(width, width <= 600 ? 0 : 200);
    assert.ok(bounds.min <= bounds.max);
    assert.ok(clampInspectorWidth(900, bounds) <= width);
  }
});
