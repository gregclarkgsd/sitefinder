import test from 'node:test';
import assert from 'node:assert/strict';
import {
  canSendInitial,
  outreachFolderFor,
  outreachTimelineFor,
} from './outreachState.js';

test('only queued, approved and failed drafts are eligible for an initial send', () => {
  for (const status of ['queued', 'approved', 'failed']) {
    assert.equal(canSendInitial(status), true, status);
  }
  assert.equal(
    canSendInitial({ status: 'failed', gmail_message_id: 'existing-gmail-message' }),
    false,
    'a failed follow-up must not become a new initial send',
  );
  for (const status of ['reviewing', 'sending', 'sent', 'followup_due', 'replied', 'bounced', 'suppressed', 'skipped', 'reconciliation_required']) {
    assert.equal(canSendInitial(status), false, status);
  }
});

test('keeps outreach records in their operational folders', () => {
  assert.equal(outreachFolderFor({status: 'queued'}), 'review');
  assert.equal(outreachFolderFor({status: 'failed'}), 'review');
  assert.equal(outreachFolderFor({status: 'approved'}), 'ready');
  assert.equal(outreachFolderFor({status: 'sent'}), 'waiting');
  assert.equal(outreachFolderFor({status: 'followup_due'}), 'followup');
  assert.equal(outreachFolderFor({status: 'sending'}), 'review');
  assert.equal(outreachFolderFor({status: 'reconciliation_required'}), 'review');
});

test('timeline distinguishes pending, completed and failed integration steps', () => {
  const pending = outreachTimelineFor({
    status: 'queued',
    created_at: '2026-07-29T09:00:00Z',
    email_subject: 'Subject',
    email_body: 'Body',
  });
  assert.deepEqual(pending.map(item => item.state), ['complete', 'complete', 'pending', 'pending']);

  const failed = outreachTimelineFor({
    status: 'failed',
    created_at: '2026-07-29T09:00:00Z',
    email_subject: 'Subject',
    email_body: 'Body',
    attio_sync_error: 'Attio unavailable',
  });
  assert.equal(failed[2].state, 'error');
  assert.equal(failed[2].detail, 'Attio unavailable');
  assert.equal(failed[3].state, 'error');

  const sent = outreachTimelineFor({
    status: 'sent',
    created_at: '2026-07-29T09:00:00Z',
    email_subject: 'Subject',
    email_body: 'Body',
    attio_record_id: 'attio-project',
    gmail_message_id: 'gmail-message',
    sent_at: '2026-07-29T10:00:00Z',
  });
  assert.deepEqual(sent.map(item => item.state), ['complete', 'complete', 'complete', 'complete']);

  const reconciliation = outreachTimelineFor({
    status: 'reconciliation_required',
    created_at: '2026-07-29T09:00:00Z',
    email_subject: 'Subject',
    email_body: 'Body',
    attio_record_id: 'attio-project',
  });
  assert.equal(reconciliation[3].state, 'error');
  assert.match(reconciliation[3].detail, /Check Gmail/);
});
