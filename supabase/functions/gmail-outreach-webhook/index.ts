import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { createClient } from 'npm:@supabase/supabase-js@2.110.7';
import {
  buildGmailHistoryPath,
  inboundLeadStatus,
  latestHistoryCursor,
  mergeHistoryMessageIds,
  nextHistoryPageToken,
} from '../_shared/gmail-reliability.js';
import { classifyProjectReply } from '../_shared/reply-outcome.js';

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function decodeBase64Url(value: string) {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '=');
  return atob(padded);
}

function base64ToBytes(value: string) {
  return Uint8Array.from(atob(value), character => character.charCodeAt(0));
}

async function decryptRefreshToken(mailbox: any) {
  const secret = Deno.env.get('MAILBOX_ENCRYPTION_KEY');
  if (!secret || !mailbox?.refresh_token_ciphertext || !mailbox?.refresh_token_iv) {
    throw new Error('The notified GSD mailbox is not connected');
  }
  const rawKey = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret));
  const key = await crypto.subtle.importKey('raw', rawKey, 'AES-GCM', false, ['decrypt']);
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: base64ToBytes(mailbox.refresh_token_iv) },
    key,
    base64ToBytes(mailbox.refresh_token_ciphertext),
  );
  return new TextDecoder().decode(plaintext);
}

async function accessToken(mailbox: any) {
  const clientId = Deno.env.get('GMAIL_CLIENT_ID');
  const clientSecret = Deno.env.get('GMAIL_CLIENT_SECRET');
  if (!clientId || !clientSecret) throw new Error('GSD Gmail OAuth is not configured');
  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: await decryptRefreshToken(mailbox),
      grant_type: 'refresh_token',
    }),
    signal: AbortSignal.timeout(20_000),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || !body.access_token) {
    throw new Error(String(body.error_description || body.error || 'Could not connect to GSD Gmail'));
  }
  return String(body.access_token);
}

async function gmail(token: string, path: string) {
  const response = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me${path}`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(25_000),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(String(body?.error?.message || `Gmail returned ${response.status}`));
  return body;
}

function header(message: any, name: string) {
  return String((message?.payload?.headers || [])
    .find((item: any) => String(item.name).toLowerCase() === name.toLowerCase())?.value || '');
}

function emailFromHeader(value: string) {
  const angle = value.match(/<([^>]+)>/);
  return String(angle?.[1] || value).trim().toLowerCase();
}

function isUniqueViolation(error: any) {
  return String(error?.code || '') === '23505';
}

function databaseError(context: string, error: any) {
  return new Error(`${context}: ${String(error?.message || error || 'database operation failed')}`);
}

const ATTIO_API = 'https://api.attio.com/v2';
const DEFAULT_DEAL_OWNER_ID = '80466c1e-bbae-4c69-a03b-560fc1680d92';

async function attioRequest(path: string, init: { method?: string; body?: unknown } = {}) {
  const token = Deno.env.get('ATTIO_ACCESS_TOKEN');
  if (!token) throw new Error('Attio deal creation is not configured');
  const response = await fetch(`${ATTIO_API}${path}`, {
    method: init.method || 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    signal: AbortSignal.timeout(25_000),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(String(body?.message || `Attio returned ${response.status}`).slice(0, 1000));
  }
  return body;
}

function attioReference(object: string, recordId: string) {
  return [{ target_object: object, target_record_id: recordId }];
}

async function createOrFindAttioDeal(lead: any) {
  const projectRecordId = String(
    lead.attio_project_record_id || lead.attio_record_id || '',
  ).trim();
  if (!projectRecordId) throw new Error('The positive reply has no linked Attio Project');

  const existing = await attioRequest('/objects/deals/records/query', {
    method: 'POST',
    body: {
      filter: {
        project: {
          target_object: 'projects',
          target_record_id: projectRecordId,
        },
      },
      limit: 2,
    },
  });
  const current = existing?.data?.[0];
  if (current?.id?.record_id) {
    return {
      recordId: String(current.id.record_id),
      webUrl: String(current.web_url || ''),
      created: false,
    };
  }

  const values: Record<string, unknown> = {
    name: `${lead.project_name} — GSD opportunity`,
    stage: 'Enquiry',
    owner: [{
      referenced_actor_type: 'workspace-member',
      referenced_actor_id: Deno.env.get('ATTIO_DEAL_OWNER_ID') || DEFAULT_DEAL_OWNER_ID,
    }],
    project: attioReference('projects', projectRecordId),
  };
  if (lead.attio_person_record_id) {
    values.associated_people = attioReference('people', String(lead.attio_person_record_id));
  }
  if (lead.attio_company_record_id) {
    values.associated_company = attioReference('companies', String(lead.attio_company_record_id));
  }

  const created = await attioRequest('/objects/deals/records', {
    method: 'POST',
    body: { data: { values } },
  });
  if (!created?.data?.id?.record_id) {
    throw new Error('Attio did not return the created Deal');
  }
  return {
    recordId: String(created.data.id.record_id),
    webUrl: String(created.data.web_url || ''),
    created: true,
  };
}

async function persistReplyOutcome(
  db: any,
  lead: any,
  providerMessageId: string,
  replyExcerpt: string,
) {
  const { data: existing, error: existingError } = await db
    .from('outreach_reply_outcomes')
    .select('*')
    .eq('provider_message_id', providerMessageId)
    .maybeSingle();
  if (existingError) throw databaseError('Could not check the reply outcome audit', existingError);
  if (existing) return existing;

  const classification = classifyProjectReply(replyExcerpt);
  const now = new Date().toISOString();
  let actionStatus = classification.outcome === 'manual_review' ? 'not_required' : 'completed';
  let actionError: string | null = null;
  let attioDealRecordId = String(lead.attio_deal_record_id || '').trim();
  let attioDealUrl = String(lead.attio_deal_url || '').trim();
  let projectDisposition = classification.outcome === 'negative'
    ? 'dead'
    : classification.outcome === 'manual_review'
      ? 'manual_review'
      : 'deal_created';

  if (classification.outcome === 'positive' && !attioDealRecordId) {
    try {
      const deal = await createOrFindAttioDeal(lead);
      attioDealRecordId = deal.recordId;
      attioDealUrl = deal.webUrl;
    } catch (error) {
      actionStatus = 'error';
      actionError = String(error instanceof Error ? error.message : error).slice(0, 1000);
      projectDisposition = 'manual_review';
    }
  }

  const { data: outcome, error: outcomeError } = await db
    .from('outreach_reply_outcomes')
    .insert({
      outreach_lead_id: lead.id,
      project_id: lead.project_id,
      provider_message_id: providerMessageId,
      outcome: classification.outcome,
      confidence: classification.confidence,
      evidence: classification.evidence,
      reply_excerpt: String(replyExcerpt || '').slice(0, 1000),
      action_status: actionStatus,
      action_error: actionError,
      attio_deal_record_id: attioDealRecordId || null,
      attio_deal_url: attioDealUrl || null,
      processed_at: now,
    })
    .select('*')
    .single();
  if (outcomeError) throw databaseError('Could not save the reply outcome audit', outcomeError);

  const { error: leadOutcomeError } = await db
    .from('outreach_leads')
    .update({
      reply_outcome: classification.outcome,
      reply_outcome_confidence: classification.confidence,
      reply_outcome_evidence: classification.evidence,
      reply_message_id: providerMessageId,
      outcome_processed_at: now,
      outcome_action_status: actionStatus,
      outcome_action_error: actionError,
      attio_deal_record_id: attioDealRecordId || null,
      attio_deal_url: attioDealUrl || null,
      updated_at: now,
    })
    .eq('id', lead.id);
  if (leadOutcomeError) throw databaseError('Could not update the outreach reply outcome', leadOutcomeError);

  const projectUpdate: Record<string, unknown> = {
    outreach_disposition: projectDisposition,
  };
  if (classification.outcome === 'negative') {
    projectUpdate.outreach_closed_at = now;
    projectUpdate.outreach_close_reason = classification.evidence;
  }
  const { error: projectError } = await db
    .from('ccs_projects')
    .update(projectUpdate)
    .eq('project_id', lead.project_id);
  if (projectError) throw databaseError('Could not update the project outreach disposition', projectError);

  return outcome;
}

async function advanceMailboxCursor(
  db: any,
  mailboxEmail: string,
  previousCursor: string | null,
  nextCursor: string,
) {
  let query = db
    .from('outreach_mailbox_state')
    .update({
      gmail_history_id: nextCursor,
      updated_at: new Date().toISOString(),
    })
    .eq('mailbox_email', mailboxEmail)
    .eq('is_active', true);
  query = previousCursor === null
    ? query.is('gmail_history_id', null)
    : query.eq('gmail_history_id', previousCursor);
  const { data, error } = await query.select('mailbox_email').maybeSingle();
  if (error) throw databaseError('Could not advance the Gmail history cursor', error);
  if (!data) {
    throw new Error('Could not advance the Gmail history cursor because another webhook changed it');
  }
}

Deno.serve(async req => {
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  const expectedSecret = Deno.env.get('GMAIL_WEBHOOK_SECRET');
  const suppliedSecret = new URL(req.url).searchParams.get('token');
  if (!expectedSecret || suppliedSecret !== expectedSecret) return json({ error: 'Unauthorised' }, 401);

  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!supabaseUrl || !serviceKey) return json({ error: 'Webhook not configured' }, 503);

  try {
    const envelope = await req.json();
    const encoded = String(envelope?.message?.data || '');
    if (!encoded) return json({ ok: true, ignored: true });
    const notification = JSON.parse(decodeBase64Url(encoded));
    const senderEmail = String(notification.emailAddress || '').trim().toLowerCase();
    if (!senderEmail.endsWith('@gsdecorating.com')) return json({ ok: true, ignored: true });
    const notificationHistoryId = latestHistoryCursor(notification.historyId);
    const db = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });
    const { data: state, error: stateError } = await db
      .from('outreach_mailbox_state')
      .select('*')
      .eq('mailbox_email', senderEmail)
      .eq('is_active', true)
      .maybeSingle();
    if (stateError) throw databaseError('Could not load the notified mailbox', stateError);
    if (!state) return json({ ok: true, ignored: true });
    if (!state?.gmail_history_id) {
      throw new Error(
        'The active mailbox has no Gmail history cursor; reconcile it before acknowledging notifications',
      );
    }

    const token = await accessToken(state);
    const startHistoryId = String(state.gmail_history_id);
    let messageIds: string[] = [];
    let pageToken = '';
    let pagesFetched = 0;
    let terminalHistoryId = startHistoryId;
    do {
      const historyPage = await gmail(
        token,
        buildGmailHistoryPath(startHistoryId, pageToken),
      );
      pagesFetched += 1;
      messageIds = mergeHistoryMessageIds(messageIds, historyPage);
      terminalHistoryId = latestHistoryCursor(
        terminalHistoryId,
        historyPage.historyId,
      );
      pageToken = nextHistoryPageToken(historyPage, pagesFetched);
    } while (pageToken);

    let processed = 0;
    let outcomesProcessed = 0;

    for (const messageId of messageIds) {
      const message = await gmail(token, `/messages/${encodeURIComponent(messageId)}?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Subject`);
      const from = emailFromHeader(header(message, 'From'));
      if (!from || from === senderEmail) continue;
      const threadId = String(message.threadId || '').trim();
      if (!threadId) continue;
      const { data: lead, error: leadLookupError } = await db
        .from('outreach_leads')
        .select('*')
        .eq('gmail_thread_id', threadId)
        .eq('sender_email', senderEmail)
        .maybeSingle();
      if (leadLookupError) {
        throw databaseError(`Could not find the outreach lead for Gmail message ${messageId}`, leadLookupError);
      }
      if (!lead) continue;

      const fromLower = from.toLowerCase();
      const snippet = String(message.snippet || '').trim();
      const isBounce = /mailer-daemon|postmaster|mail delivery subsystem/i.test(fromLower)
        || /delivery status notification|undeliverable|delivery failed/i.test(header(message, 'Subject'));
      const isOptOut = /\b(unsubscribe|remove me|do not contact|stop emailing)\b/i.test(snippet);
      const detectedStatus = isBounce ? 'bounced' : isOptOut ? 'suppressed' : 'replied';
      const nextStatus = inboundLeadStatus(lead.status, detectedStatus);
      const now = new Date().toISOString();
      const internalDate = Number(message.internalDate);
      const occurredAt = Number.isFinite(internalDate) && internalDate > 0
        ? new Date(internalDate).toISOString()
        : now;

      const { error: communicationError } = await db.from('outreach_communications').insert({
        project_id: lead.project_id,
        outreach_lead_id: lead.id,
        direction: 'inbound',
        channel: 'email',
        status: isBounce ? 'bounced' : 'received',
        sender_email: from,
        recipient_email: senderEmail,
        subject: header(message, 'Subject'),
        body: snippet || 'Incoming Gmail message',
        provider: 'gmail',
        provider_message_id: messageId,
        occurred_at: occurredAt,
        created_by: lead.approved_by || lead.created_by,
      });
      if (communicationError && !isUniqueViolation(communicationError)) {
        throw databaseError(`Could not save Gmail communication ${messageId}`, communicationError);
      }

      let leadUpdate = db.from('outreach_leads').update({
        status: nextStatus,
        follow_up_enabled: false,
        next_follow_up_at: null,
        last_reply_at: !isBounce && !isOptOut ? occurredAt : lead.last_reply_at,
        last_bounce_at: isBounce ? occurredAt : lead.last_bounce_at,
        last_unsubscribe_at: isOptOut ? occurredAt : lead.last_unsubscribe_at,
        updated_at: now,
      }).eq('id', lead.id);
      if (lead.updated_at) leadUpdate = leadUpdate.eq('updated_at', lead.updated_at);
      const { data: updatedLead, error: leadUpdateError } = await leadUpdate
        .select('id')
        .maybeSingle();
      if (leadUpdateError) {
        throw databaseError(`Could not update the outreach lead for Gmail message ${messageId}`, leadUpdateError);
      }
      if (!updatedLead) {
        throw new Error(`Could not update the outreach lead for Gmail message ${messageId}`);
      }

      if (!isBounce && !isOptOut) {
        await persistReplyOutcome(db, lead, messageId, snippet);
        outcomesProcessed += 1;
      }

      if (isOptOut) {
        const suppressionEmail = String(lead.recipient_email || from).trim().toLowerCase();
        const { error: suppressionError } = await db.from('outreach_suppressions').insert({
          email: suppressionEmail,
          reason: 'Recipient requested no further contact',
          source: 'gmail-reply',
          created_by: lead.approved_by || lead.created_by,
        });
        if (suppressionError && !isUniqueViolation(suppressionError)) {
          throw databaseError(`Could not save the suppression for ${suppressionEmail}`, suppressionError);
        }
      }
      processed += 1;
    }

    const nextCursor = latestHistoryCursor(
      startHistoryId,
      terminalHistoryId,
      notificationHistoryId,
    );
    await advanceMailboxCursor(db, senderEmail, startHistoryId, nextCursor);
    return json({
      ok: true,
      pages_fetched: pagesFetched,
      messages_examined: messageIds.length,
      processed,
      outcomes_processed: outcomesProcessed,
      gmail_history_id: nextCursor,
    });
  } catch (error) {
    return json({ error: String(error instanceof Error ? error.message : error) }, 502);
  }
});
