import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import test from 'node:test';
import {
  researchCredentialMatches,
  secretsMatch,
  tokenHashMatches,
} from './credential-utils.js';

test('compares raw server credentials without accepting missing values', () => {
  assert.equal(secretsMatch('pilot-token', 'pilot-token'), true);
  assert.equal(secretsMatch('pilot-token', 'different-token'), false);
  assert.equal(secretsMatch('', ''), false);
});

test('accepts a high-entropy token through its deployed SHA-256 hash', () => {
  const token = 'local-only-high-entropy-pilot-token';
  const hash = createHash('sha256').update(token).digest('hex');
  assert.equal(tokenHashMatches(token, hash), true);
  assert.equal(tokenHashMatches('wrong-token', hash), false);
  assert.equal(researchCredentialMatches(token, undefined, hash), true);
});

test('keeps the existing raw Render credential compatible', () => {
  assert.equal(
    researchCredentialMatches('existing-render-token', 'existing-render-token', undefined),
    true,
  );
});
