import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertSafeCcsFeedSnapshot,
  canonicalCcsSiteId,
  isExplicitlyEnabled,
} from './sync-safety.js';

test('requires an explicit true value before automatic Attio sync', () => {
  assert.equal(isExplicitlyEnabled('true'), true);
  assert.equal(isExplicitlyEnabled(' TRUE '), true);
  assert.equal(isExplicitlyEnabled('1'), false);
  assert.equal(isExplicitlyEnabled(undefined), false);
});

test('normalises SiteFinder IDs to the canonical numeric CCS value', () => {
  assert.equal(canonicalCcsSiteId('site520001'), '520001');
  assert.equal(canonicalCcsSiteId('520001'), '520001');
  assert.throws(() => canonicalCcsSiteId('project-520001'), /Invalid CCS/u);
});

test('rejects empty or implausibly truncated CCS feeds before deactivation', () => {
  assert.throws(
    () => assertSafeCcsFeedSnapshot([], 0, 1000),
    /no target projects/u,
  );
  assert.throws(
    () => assertSafeCcsFeedSnapshot([{}], 400, 1000),
    /minimum safe count is 500/u,
  );
  assert.doesNotThrow(
    () => assertSafeCcsFeedSnapshot([{}], 800, 1000),
  );
});
