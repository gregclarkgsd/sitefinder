import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyProjectReply } from './reply-outcome.js';

test('classifies explicit positive project replies', () => {
  const result = classifyProjectReply('Yes, it is still live. Please send a quote.');
  assert.equal(result.outcome, 'positive');
  assert.equal(result.confidence, 0.95);
});

test('classifies explicit negative project replies', () => {
  const result = classifyProjectReply('Sorry, the project is on hold for now.');
  assert.equal(result.outcome, 'negative');
});

test('sends conflicting or vague replies to manual review', () => {
  assert.equal(classifyProjectReply('Still live, but not interested.').outcome, 'manual_review');
  assert.equal(classifyProjectReply('Thanks for your email.').outcome, 'manual_review');
});

test('ignores quoted history below the reply', () => {
  const result = classifyProjectReply('Thanks. On Mon, 1 Sep 2026, Sam wrote: is it still live?');
  assert.equal(result.outcome, 'manual_review');
});
