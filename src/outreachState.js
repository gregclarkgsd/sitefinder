const INITIAL_SEND_STATUSES = new Set(['queued', 'approved', 'failed']);

export function canSendInitial(status) {
  const lead = status && typeof status === 'object' ? status : { status };
  return INITIAL_SEND_STATUSES.has(String(lead.status || ''))
    && !String(lead.gmail_message_id || '').trim();
}

export function outreachFolderFor(lead) {
  if (lead?.status === 'approved') return 'ready';
  if (lead?.status === 'followup_due') return 'followup';
  if (lead?.status === 'sent') return 'waiting';
  return 'review';
}

export function outreachStatusLabel(status) {
  return {
    queued: 'Needs review',
    reviewing: 'Needs review',
    approved: 'Ready to send',
    sending: 'Sending in progress',
    sent: 'Waiting for reply',
    followup_due: 'Follow-up due',
    skipped: 'Saved for later',
    replied: 'Replied',
    bounced: 'Bounced',
    failed: 'Failed',
    reconciliation_required: 'Reconciliation required',
    suppressed: 'Do not contact',
  }[status] || status || 'Status unknown';
}

function step(id, label, state, detail) {
  return { id, label, state, detail };
}

export function outreachTimelineFor(lead = {}) {
  const created = lead.created_at
    ? step('found', 'New project found', 'complete', lead.created_at)
    : step('found', 'New project found', 'pending', 'Discovery time not recorded');

  const draftReady = Boolean(
    String(lead.email_subject || '').trim()
    && String(lead.email_body || '').trim(),
  );
  const draft = draftReady
    ? step('draft', 'Email draft ready', 'complete', lead.updated_at || lead.created_at)
    : step('draft', 'Email draft ready', 'pending', 'Draft incomplete');

  let attio = step('attio', 'Project linked to Attio', 'pending', 'CRM sync pending');
  if (lead.attio_sync_error) {
    attio = step(
      'attio',
      'Project linked to Attio',
      'error',
      String(lead.attio_sync_error).slice(0, 180),
    );
  } else if (lead.attio_synced_at || lead.attio_record_id) {
    attio = step(
      'attio',
      'Project linked to Attio',
      'complete',
      lead.attio_synced_at || 'Linked',
    );
  }

  let email = step('email', 'Email sent', 'pending', outreachStatusLabel(lead.status));
  if (lead.status === 'failed') {
    email = step('email', 'Email sent', 'error', 'Send failed');
  } else if (lead.status === 'reconciliation_required') {
    email = step('email', 'Email status', 'error', 'Check Gmail before taking any further action');
  } else if (lead.status === 'bounced') {
    email = step('email', 'Email delivery', 'error', 'Email bounced');
  } else if (lead.status === 'suppressed') {
    email = step('email', 'Email sent', 'error', 'Do not contact');
  } else if (lead.status === 'replied') {
    email = step('email', 'Reply received', 'complete', lead.replied_at || lead.updated_at || 'Reply recorded');
  } else if (
    lead.gmail_message_id
    || lead.sent_at
    || ['sent', 'followup_due'].includes(lead.status)
  ) {
    email = step('email', 'Email sent', 'complete', lead.sent_at || lead.updated_at || 'Sent');
  }

  return [created, draft, attio, email];
}

export function outreachStatusGuidance(status) {
  return {
    reviewing: 'This draft is still being prepared and cannot be sent yet.',
    sending: 'Gmail is processing this send. Wait for SiteFinder to record the result before taking another action.',
    sent: 'The initial email has been sent. SiteFinder is waiting for a reply and will manage any enabled follow-ups.',
    followup_due: 'A follow-up is due. SiteFinder’s scheduled follow-up process will handle it on the existing Gmail thread.',
    replied: 'A reply has been recorded. No further automated follow-up will be sent.',
    bounced: 'This email bounced. Check the contact before creating any new outreach.',
    suppressed: 'This address is on the do-not-contact list and cannot be emailed.',
    skipped: 'This outreach has been saved for later and is not eligible to send.',
    failed: 'A previous email action failed after this thread was created. Check Gmail and the project history before taking another action.',
    reconciliation_required: 'SiteFinder could not confirm the final Gmail state. Do not retry. Check Gmail and reconcile this record first.',
  }[status] || 'This outreach record is not eligible for an initial email.';
}
