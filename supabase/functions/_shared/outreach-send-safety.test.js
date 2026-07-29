import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildSendClaimRelease,
  buildSendReconciliationState,
  buildSendClaimState,
  isUnknownGmailFailureStatus,
} from './outreach-send-safety.js';

const claimedAt = '2026-07-29T20:00:00.000Z';
const actorId = '11111111-1111-4111-8111-111111111111';

test('initial send claim becomes non-retryable before Gmail is called', () => {
  const claim = buildSendClaimState({
    status: 'approved',
    sent_at: null,
    follow_up_step: 0,
    next_follow_up_at: null,
  }, false, 0, actorId, claimedAt);
  assert.deepEqual(claim.updates, {
    status: 'sending',
    send_claimed_at: claimedAt,
    send_error: null,
    follow_up_step: 0,
    next_follow_up_at: null,
    updated_at: claimedAt,
    updated_by: actorId,
  });
  assert.equal(claim.previous.status, 'approved');
});

test('follow-up claim consumes the due timestamp and advances the step atomically', () => {
  const claim = buildSendClaimState({
    status: 'followup_due',
    sent_at: '2026-07-20T10:00:00.000Z',
    follow_up_step: 1,
    next_follow_up_at: '2026-07-29T19:00:00.000Z',
  }, true, 2, actorId, claimedAt);
  assert.equal(claim.updates.status, 'sending');
  assert.equal(claim.updates.follow_up_step, 2);
  assert.equal(claim.updates.next_follow_up_at, null);
  assert.equal(claim.previous.follow_up_step, 1);
  assert.equal(claim.previous.next_follow_up_at, '2026-07-29T19:00:00.000Z');
});

test('a definitive Gmail rejection can restore the exact pre-claim state', () => {
  const claim = buildSendClaimState({
    status: 'sent',
    sent_at: '2026-07-20T10:00:00.000Z',
    follow_up_step: 0,
    next_follow_up_at: '2026-07-29T19:00:00.000Z',
  }, true, 1, actorId, claimedAt);
  assert.deepEqual(
    buildSendClaimRelease(claim, actorId, '2026-07-29T20:00:02.000Z'),
    {
      status: 'sent',
      sent_at: '2026-07-20T10:00:00.000Z',
      follow_up_step: 0,
      next_follow_up_at: '2026-07-29T19:00:00.000Z',
      send_claimed_at: null,
      send_error: null,
      updated_at: '2026-07-29T20:00:02.000Z',
      updated_by: actorId,
    },
  );
});

test('an unknown Gmail outcome becomes a durable reconciliation state', () => {
  const claimState = buildSendClaimState({
    status: 'approved',
    sent_at: null,
    follow_up_step: 0,
    next_follow_up_at: null,
  }, false, 0, actorId, claimedAt);
  const claim = {
    claimedAt,
    previous: claimState.previous,
  };
  assert.deepEqual(
    buildSendReconciliationState(
      claim,
      actorId,
      '2026-07-29T20:00:03.000Z',
      'Network response lost',
    ),
    {
      status: 'reconciliation_required',
      send_claimed_at: claimedAt,
      send_error: 'Network response lost',
      updated_at: '2026-07-29T20:00:03.000Z',
      updated_by: actorId,
    },
  );
});

test('conservatively treats Gmail timeouts and server failures as unknown outcomes', () => {
  assert.equal(isUnknownGmailFailureStatus(408), true);
  assert.equal(isUnknownGmailFailureStatus(500), true);
  assert.equal(isUnknownGmailFailureStatus(503), true);
  assert.equal(isUnknownGmailFailureStatus(400), false);
  assert.equal(isUnknownGmailFailureStatus(401), false);
  assert.equal(isUnknownGmailFailureStatus(429), false);
});
