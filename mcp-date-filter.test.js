import assert from 'node:assert/strict';
import test from 'node:test';
import { inDateRange } from './mcp/sitefinder-mcp.js';

test('filters project dates inclusively and rejects missing dates when a window is requested', () => {
  assert.equal(inDateRange('2027-01-01', '2027-01-01', '2027-06-30'), true);
  assert.equal(inDateRange('2027-06-30', '2027-01-01', '2027-06-30'), true);
  assert.equal(inDateRange('2026-12-31', '2027-01-01', '2027-06-30'), false);
  assert.equal(inDateRange('2027-07-01', '2027-01-01', '2027-06-30'), false);
  assert.equal(inDateRange(null, '2027-01-01', '2027-06-30'), false);
  assert.equal(inDateRange(null, undefined, undefined), true);
});
