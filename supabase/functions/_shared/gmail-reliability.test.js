import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildGmailHistoryPath,
  classifyFollowupResponse,
  classifyFollowupStateAfterInvocation,
  initialWatchState,
  inboundLeadStatus,
  latestHistoryCursor,
  mergeHistoryMessageIds,
  nextHistoryPageToken,
  summariseFollowupResults,
  watchRenewalUpdate,
} from './gmail-reliability.js';

test('builds paginated Gmail history requests from one stable cursor', () => {
  const path = buildGmailHistoryPath('9876543210', 'next/page token');
  const url = new URL(path, 'https://gmail.googleapis.com');
  assert.equal(url.pathname, '/history');
  assert.equal(url.searchParams.get('startHistoryId'), '9876543210');
  assert.equal(url.searchParams.get('maxResults'), '500');
  assert.equal(url.searchParams.get('historyTypes'), 'messageAdded');
  assert.equal(url.searchParams.get('pageToken'), 'next/page token');
});

test('deduplicates message IDs across replayed Gmail history pages', () => {
  const first = mergeHistoryMessageIds([], {
    history: [{ messagesAdded: [{ message: { id: 'm1' } }, { message: { id: 'm2' } }] }],
  });
  const second = mergeHistoryMessageIds(first, {
    history: [{ messagesAdded: [{ message: { id: 'm2' } }, { message: { id: 'm3' } }] }],
  });
  assert.deepEqual(second, ['m1', 'm2', 'm3']);
});

test('refuses to silently truncate paginated Gmail history', () => {
  assert.equal(nextHistoryPageToken({ nextPageToken: 'page-2' }, 1, 3), 'page-2');
  assert.equal(nextHistoryPageToken({}, 1, 3), '');
  assert.throws(
    () => nextHistoryPageToken({ nextPageToken: 'page-4' }, 3, 3),
    /safe 3-page limit/u,
  );
});

test('compares Gmail history cursors without losing 64-bit precision', () => {
  assert.equal(
    latestHistoryCursor('9999999999999999999', '10000000000000000000'),
    '10000000000000000000',
  );
});

test('watch renewal updates expiration but never returns a history cursor write', () => {
  const update = watchRenewalUpdate(
    { historyId: '999', expiration: '1785456000000' },
    '2026-07-29T20:00:00.000Z',
  );
  assert.equal(update.watch_expiration, '2026-07-31T00:00:00.000Z');
  assert.equal(Object.hasOwn(update, 'gmail_history_id'), false);
});

test('an initial Gmail watch requires both a cursor and a future expiration', () => {
  assert.deepEqual(
    initialWatchState(
      { historyId: '000123', expiration: '1785456000000' },
      '2026-07-29T20:00:00.000Z',
    ),
    {
      gmail_history_id: '123',
      watch_expiration: '2026-07-31T00:00:00.000Z',
      last_error: null,
      updated_at: '2026-07-29T20:00:00.000Z',
    },
  );
  assert.throws(
    () => initialWatchState(
      { expiration: '1785456000000' },
      '2026-07-29T20:00:00.000Z',
    ),
    /valid history cursor/u,
  );
});

test('a replayed reply cannot weaken a do-not-contact lead status', () => {
  assert.equal(inboundLeadStatus('suppressed', 'replied'), 'suppressed');
  assert.equal(inboundLeadStatus('sent', 'replied'), 'replied');
});

test('classifies child follow-up responses without letting their body override runner truth', () => {
  assert.deepEqual(
    classifyFollowupResponse(502, false, {
      ok: true,
      email_sent: true,
      retry_safe: false,
      reconciliation_required: true,
      error: 'History persistence failed',
    }),
    {
      ok: false,
      http_status: 502,
      outcome: 'reconciliation_required',
      email_sent: true,
      retry_safe: false,
      reconciliation_required: true,
      error: 'History persistence failed',
    },
  );
});

test('does not mistake the existing initial Gmail message for a timed-out follow-up', () => {
  assert.deepEqual(
    classifyFollowupStateAfterInvocation(
      { follow_up_step: 0, gmail_message_id: 'initial-message' },
      { status: 'sent', follow_up_step: 0, gmail_message_id: 'initial-message' },
    ),
    {
      ok: false,
      http_status: 0,
      outcome: 'invocation_unknown',
      email_sent: null,
      retry_safe: false,
      reconciliation_required: false,
    },
  );

  assert.equal(
    classifyFollowupStateAfterInvocation(
      { follow_up_step: 0, gmail_message_id: 'initial-message' },
      { status: 'sent', follow_up_step: 1, gmail_message_id: 'followup-message' },
    ).outcome,
    'sent_state_observed',
  );
});

test('summarises partial follow-up processing truthfully', () => {
  assert.deepEqual(
    summariseFollowupResults([
      { ok: true },
      { ok: false, reconciliation_required: true },
    ], 3),
    {
      ok: false,
      partial: true,
      attempted: 2,
      succeeded: 1,
      failed: 1,
      reconciliationRequired: 1,
      deferred: 1,
    },
  );
});
