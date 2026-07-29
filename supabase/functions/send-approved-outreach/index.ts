import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { createClient } from 'npm:@supabase/supabase-js@2.110.7';
import {
  buildSendClaimRelease,
  buildSendReconciliationState,
  buildSendClaimState,
  isUnknownGmailFailureStatus,
} from '../_shared/outreach-send-safety.js';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

function cleanHeader(value: unknown) {
  return String(value || '').replace(/[\r\n]+/g, ' ').trim();
}

function base64Url(value: string) {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function firstName(value: unknown) {
  return String(value || '').trim().split(/\s+/)[0] || 'there';
}

function followUpCopy(lead: any, step: number, senderName: string) {
  const greeting = `Hi ${firstName(lead.recipient_name)},`;
  const signoff = senderName || 'GSD Decorating';
  if (step === 1) {
    return `${greeting}

I wanted to follow up on my note about ${lead.project_name}.

GSD Decorating would be pleased to price the relevant painting, decorating or spray packages. Please let me know if you are the right person to speak with.

Kind regards,
${signoff}
GSD Decorating`;
  }
  return `${greeting}

Just a final follow-up regarding ${lead.project_name}.

If the package is still available, we would welcome the opportunity to introduce GSD and price the work. If it is not relevant, no problem at all and I will close this out.

Kind regards,
${signoff}
GSD Decorating`;
}

function base64ToBytes(value: string) {
  return Uint8Array.from(atob(value), character => character.charCodeAt(0));
}

async function decryptRefreshToken(mailbox: any) {
  const secret = Deno.env.get('MAILBOX_ENCRYPTION_KEY');
  if (!secret || !mailbox?.refresh_token_ciphertext || !mailbox?.refresh_token_iv) {
    throw new Error('The selected GSD mailbox is not connected');
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

async function gmailAccessToken(mailbox: any) {
  const clientId = Deno.env.get('GMAIL_CLIENT_ID');
  const clientSecret = Deno.env.get('GMAIL_CLIENT_SECRET');
  const refreshToken = await decryptRefreshToken(mailbox);
  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error('GSD Gmail connection is not configured');
  }
  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
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

class GmailRequestError extends Error {
  outcomeUnknown: boolean;

  constructor(message: string, outcomeUnknown = false) {
    super(message);
    this.name = 'GmailRequestError';
    this.outcomeUnknown = outcomeUnknown;
  }
}

async function gmailRequest(
  accessToken: string,
  path: string,
  init: RequestInit = {},
  outcomeUnknownOnNetworkFailure = false,
) {
  let response;
  try {
    response = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        ...(init.headers || {}),
      },
      signal: init.signal || AbortSignal.timeout(25_000),
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new GmailRequestError(
      outcomeUnknownOnNetworkFailure
        ? `Gmail send outcome is unknown after a network failure: ${detail}`
        : `Gmail request failed before completion: ${detail}`,
      outcomeUnknownOnNetworkFailure,
    );
  }
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new GmailRequestError(
      String(body?.error?.message || `Gmail returned ${response.status}`).slice(0, 1000),
      outcomeUnknownOnNetworkFailure && isUnknownGmailFailureStatus(response.status),
    );
  }
  return body;
}

async function claimSend(
  db: any,
  lead: any,
  isFollowUp: boolean,
  followUpStep: number,
  actorId: string,
) {
  const claimedAt = new Date().toISOString();
  const claimState = buildSendClaimState(
    lead,
    isFollowUp,
    followUpStep,
    actorId,
    claimedAt,
  );
  let query = db
    .from('outreach_leads')
    .update(claimState.updates)
    .eq('id', lead.id);
  if (isFollowUp) {
    query = query
      .eq('status', lead.status)
      .eq('follow_up_step', Number(lead.follow_up_step || 0))
      .eq('next_follow_up_at', lead.next_follow_up_at);
  } else {
    query = query
      .eq('status', 'approved')
      .is('gmail_message_id', null);
  }
  if (lead.updated_at) {
    query = query.eq('updated_at', lead.updated_at);
  }
  const { data, error } = await query.select('*').maybeSingle();
  if (error) throw error;
  if (!data) return null;
  return {
    lead: data,
    claimedAt: String(data.send_claimed_at || claimedAt),
    version: String(data.updated_at || claimedAt),
    previous: claimState.previous,
  };
}

async function releaseSendClaim(db: any, claim: any, actorId: string) {
  const releasedAt = new Date().toISOString();
  const { data, error } = await db
    .from('outreach_leads')
    .update(buildSendClaimRelease(claim, actorId, releasedAt))
    .eq('id', claim.lead.id)
    .eq('status', 'sending')
    .eq('send_claimed_at', claim.claimedAt)
    .eq('updated_at', claim.version)
    .select('id')
    .maybeSingle();
  return {
    released: Boolean(data) && !error,
    error: error?.message || (!data ? 'send claim changed before it could be released' : null),
  };
}

async function markSendReconciliation(
  db: any,
  claim: any,
  actorId: string,
  message: string,
  providerFields: Record<string, unknown> = {},
  expectedStatus = 'sending',
  expectedVersion = claim.version,
) {
  const reconciledAt = new Date().toISOString();
  let query = db
    .from('outreach_leads')
    .update({
      ...buildSendReconciliationState(claim, actorId, reconciledAt, message),
      ...providerFields,
    })
    .eq('id', claim.lead.id)
    .eq('status', expectedStatus);
  if (expectedStatus === 'sending') {
    query = query.eq('send_claimed_at', claim.claimedAt);
  }
  if (expectedVersion) {
    query = query.eq('updated_at', expectedVersion);
  }
  const { data, error } = await query.select('id,updated_at').maybeSingle();
  return {
    persisted: Boolean(data) && !error,
    version: data?.updated_at || null,
    error: error?.message || (!data
      ? 'send state changed before reconciliation could be recorded'
      : null),
  };
}

Deno.serve(async req => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY');
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!supabaseUrl || !anonKey || !serviceKey) {
    return json({ error: 'Outreach sending is not fully configured' }, 503);
  }

  const cronSecret = req.headers.get('x-sitefinder-cron-secret');
  const isCron = Boolean(
    cronSecret
    && Deno.env.get('OUTREACH_CRON_SECRET')
    && cronSecret === Deno.env.get('OUTREACH_CRON_SECRET'),
  );
  let authenticatedUserId = '';
  if (!isCron) {
    const authorization = req.headers.get('Authorization') || '';
    const userClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authorization } },
      auth: { persistSession: false },
    });
    const { data: userData, error: userError } = await userClient.auth.getUser();
    const userEmail = String(userData.user?.email || '').toLowerCase();
    if (userError || !userEmail.endsWith('@gsdecorating.com')) {
      return json({ error: 'Authorised GSD account required' }, 403);
    }
    authenticatedUserId = String(userData.user?.id || '');
  }

  let leadId = '';
  let mode = 'initial';
  try {
    const requestBody = await req.json();
    leadId = String(requestBody.lead_id || '');
    mode = requestBody.mode === 'followup' ? 'followup' : 'initial';
  } catch {
    return json({ error: 'Invalid request body' }, 400);
  }
  if (!/^[0-9a-f-]{36}$/i.test(leadId)) return json({ error: 'Valid lead_id required' }, 400);

  const db = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });
  const { data: lead, error: leadError } = await db
    .from('outreach_leads')
    .select('*')
    .eq('id', leadId)
    .single();
  if (leadError || !lead) return json({ error: 'Outreach lead not found' }, 404);
  const actorId = authenticatedUserId || String(lead.approved_by || lead.created_by || '');
  if (!actorId) return json({ error: 'Outreach lead has no accountable GSD owner' }, 409);
  if (!lead.attio_record_id) {
    return json({ error: 'Complete the approved Attio Project handoff before sending email' }, 409);
  }
  const senderEmail = cleanHeader(lead.sender_email).toLowerCase();
  if (!senderEmail.endsWith('@gsdecorating.com')) {
    return json({ error: 'Choose a connected GSD sending mailbox first' }, 409);
  }
  const { data: mailbox, error: mailboxError } = await db
    .from('outreach_mailbox_state')
    .select('*')
    .eq('mailbox_email', senderEmail)
    .eq('is_active', true)
    .maybeSingle();
  if (mailboxError || !mailbox) return json({ error: 'The selected GSD mailbox is not connected' }, 409);

  const recipient = cleanHeader(lead.recipient_email).toLowerCase();
  if (!recipient || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(recipient)) {
    return json({ error: 'A valid recipient email is required' }, 409);
  }
  const { data: suppression, error: suppressionError } = await db
    .from('outreach_suppressions')
    .select('id,reason')
    .eq('email', recipient)
    .maybeSingle();
  if (suppressionError) {
    return json({
      error: `The email was not sent because SiteFinder could not verify the do-not-contact register: ${
        suppressionError.message
      }`,
      email_sent: false,
      retry_safe: true,
      reconciliation_required: false,
    }, 502);
  }
  if (suppression || ['suppressed', 'replied', 'bounced'].includes(lead.status)) {
    return json({ error: suppression ? `Do not contact: ${suppression.reason}` : `Lead is ${lead.status}` }, 409);
  }

  const isFollowUp = mode === 'followup';
  if (!isFollowUp && lead.status !== 'approved') {
    return json({ error: 'The first email must be approved before sending' }, 409);
  }
  if (!isFollowUp && lead.gmail_message_id) {
    return json({ error: 'This approved email has already been sent' }, 409);
  }
  if (isFollowUp) {
    if (!lead.follow_up_enabled || !['sent', 'followup_due'].includes(lead.status)) {
      return json({ error: 'Follow-up is not enabled for this lead' }, 409);
    }
    if (!lead.next_follow_up_at || new Date(lead.next_follow_up_at) > new Date()) {
      return json({ error: 'Follow-up is not due yet' }, 409);
    }
    if (Number(lead.follow_up_step || 0) >= 2) {
      return json({ error: 'The approved follow-up sequence is complete' }, 409);
    }
  }

  const followUpStep = isFollowUp ? Number(lead.follow_up_step || 0) + 1 : 0;
  const subject = cleanHeader(
    isFollowUp ? `Re: ${String(lead.email_subject || '').replace(/^Re:\s*/i, '')}` : lead.email_subject,
  );
  const body = isFollowUp
    ? followUpCopy(lead, followUpStep, String(mailbox.display_name || '').trim())
    : String(lead.email_body || '').trim();
  if (!subject || !body) return json({ error: 'Approved email subject and body are required' }, 409);

  const headers = [
    `From: ${senderEmail}`,
    `To: ${recipient}`,
    `Subject: ${subject}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: 8bit',
  ];
  if (isFollowUp && lead.gmail_rfc_message_id) {
    headers.push(`In-Reply-To: ${cleanHeader(lead.gmail_rfc_message_id)}`);
    headers.push(`References: ${cleanHeader(lead.gmail_rfc_message_id)}`);
  }
  const raw = `${headers.join('\r\n')}\r\n\r\n${body.replace(/\r?\n/g, '\r\n')}`;

  let accessToken;
  try {
    accessToken = await gmailAccessToken(mailbox);
  } catch (error) {
    return json({
      error: String(error instanceof Error ? error.message : error).slice(0, 1000),
      email_sent: false,
      retry_safe: true,
      reconciliation_required: false,
    }, 502);
  }

  let claim;
  try {
    claim = await claimSend(db, lead, isFollowUp, followUpStep, actorId);
  } catch (error) {
    return json({
      error: `The email was not sent because SiteFinder could not claim the lead: ${
        String(error instanceof Error ? error.message : error).slice(0, 900)
      }`,
      email_sent: false,
      retry_safe: true,
      reconciliation_required: false,
    }, 502);
  }
  if (!claim) {
    return json({
      error: 'Another send request already claimed or changed this lead',
      email_sent: false,
      retry_safe: false,
      reconciliation_required: false,
    }, 409);
  }

  let sent;
  try {
    sent = await gmailRequest(accessToken, '/messages/send', {
      method: 'POST',
      body: JSON.stringify({
        raw: base64Url(raw),
        ...(isFollowUp && lead.gmail_thread_id ? { threadId: lead.gmail_thread_id } : {}),
      }),
    }, true);
  } catch (error) {
    const message = String(error instanceof Error ? error.message : error).slice(0, 1000);
    if (error instanceof GmailRequestError && error.outcomeUnknown) {
      const reconciliation = await markSendReconciliation(
        db,
        claim,
        actorId,
        message,
      );
      return json({
        error: message,
        email_sent: null,
        retry_safe: false,
        reconciliation_required: true,
        reconciliation_persisted: reconciliation.persisted,
        reconciliation_error: reconciliation.error,
        lead_id: lead.id,
        lead_status: reconciliation.persisted ? 'reconciliation_required' : 'unknown',
      }, 502);
    }
    const release = await releaseSendClaim(db, claim, actorId);
    if (!release.released) {
      const reconciliationMessage = `${message}. Gmail rejected the request, but SiteFinder could not safely release the send claim: ${
        release.error || 'unknown persistence error'
      }`;
      const reconciliation = await markSendReconciliation(
        db,
        claim,
        actorId,
        reconciliationMessage,
      );
      return json({
        error: reconciliationMessage,
        email_sent: false,
        retry_safe: false,
        reconciliation_required: true,
        reconciliation_persisted: reconciliation.persisted,
        reconciliation_error: reconciliation.error,
        release_error: release.error,
        lead_id: lead.id,
        lead_status: reconciliation.persisted ? 'reconciliation_required' : 'unknown',
      }, 502);
    }
    return json({
      error: message,
      email_sent: false,
      retry_safe: true,
      reconciliation_required: false,
      lead_id: lead.id,
    }, 502);
  }

  if (!sent?.id) {
    const message = 'Gmail accepted the send request but returned no message identifier';
    const reconciliation = await markSendReconciliation(
      db,
      claim,
      actorId,
      message,
      sent?.threadId ? { gmail_thread_id: sent.threadId } : {},
    );
    return json({
      error: message,
      email_sent: true,
      retry_safe: false,
      reconciliation_required: true,
      reconciliation_persisted: reconciliation.persisted,
      reconciliation_error: reconciliation.error,
      lead_id: lead.id,
      lead_status: reconciliation.persisted ? 'reconciliation_required' : 'unknown',
    }, 502);
  }

  let messageIdHeader = null;
  try {
    const metadata = await gmailRequest(
      accessToken,
      `/messages/${encodeURIComponent(sent.id)}?format=metadata&metadataHeaders=Message-ID`,
    );
    messageIdHeader = (metadata?.payload?.headers || [])
      .find((header: any) => String(header.name).toLowerCase() === 'message-id')?.value || null;
  } catch {
    // The Gmail API send response is authoritative; metadata is optional.
  }
  const now = new Date();
  const sequenceComplete = followUpStep >= 2;
  const nextFollowUpAt = lead.follow_up_enabled && !sequenceComplete
    ? new Date(now.getTime() + 5 * 86400000).toISOString()
    : null;

  const { data: persistedLead, error: updateError } = await db.from('outreach_leads').update({
    status: 'sent',
    sender_email: senderEmail,
    sent_at: lead.sent_at || now.toISOString(),
    gmail_message_id: sent.id,
    gmail_thread_id: sent.threadId || lead.gmail_thread_id,
    gmail_rfc_message_id: messageIdHeader || lead.gmail_rfc_message_id,
    follow_up_step: followUpStep,
    next_follow_up_at: nextFollowUpAt,
    send_claimed_at: null,
    send_error: null,
    updated_at: now.toISOString(),
    updated_by: actorId,
  })
    .eq('id', lead.id)
    .eq('status', 'sending')
    .eq('send_claimed_at', claim.claimedAt)
    .eq('updated_at', claim.version)
    .select('id,updated_at')
    .maybeSingle();
  if (updateError || !persistedLead) {
    const message = `Email was sent, but lead status could not be finalised: ${
      updateError?.message || 'send claim changed before finalisation'
    }`;
    const reconciliation = await markSendReconciliation(
      db,
      claim,
      actorId,
      message,
      {
        sender_email: senderEmail,
        sent_at: lead.sent_at || now.toISOString(),
        gmail_message_id: sent.id,
        gmail_thread_id: sent.threadId || lead.gmail_thread_id,
        gmail_rfc_message_id: messageIdHeader || lead.gmail_rfc_message_id,
        follow_up_step: followUpStep,
        next_follow_up_at: null,
      },
    );
    return json({
      error: message,
      email_sent: true,
      retry_safe: false,
      reconciliation_required: true,
      reconciliation_persisted: reconciliation.persisted,
      reconciliation_error: reconciliation.error,
      gmail_message_id: sent.id,
      gmail_thread_id: sent.threadId || lead.gmail_thread_id,
      lead_id: lead.id,
      lead_status: reconciliation.persisted ? 'reconciliation_required' : 'unknown',
    }, 502);
  }

  const { error: communicationError } = await db.from('outreach_communications').insert({
    project_id: lead.project_id,
    outreach_lead_id: lead.id,
    direction: 'outbound',
    channel: 'email',
    status: 'sent',
    sender_email: senderEmail,
    recipient_email: recipient,
    subject,
    body,
    provider: 'gmail',
    provider_message_id: sent.id,
    occurred_at: now.toISOString(),
    created_by: actorId,
  });
  if (communicationError) {
    const message = `Email was sent, but communication history could not be saved: ${communicationError.message}`;
    const reconciliation = await markSendReconciliation(
      db,
      claim,
      actorId,
      message,
      {
        sender_email: senderEmail,
        sent_at: lead.sent_at || now.toISOString(),
        gmail_message_id: sent.id,
        gmail_thread_id: sent.threadId || lead.gmail_thread_id,
        gmail_rfc_message_id: messageIdHeader || lead.gmail_rfc_message_id,
        follow_up_step: followUpStep,
        next_follow_up_at: nextFollowUpAt,
      },
      'sent',
      String(persistedLead.updated_at || ''),
    );
    return json({
      error: message,
      email_sent: true,
      retry_safe: false,
      reconciliation_required: true,
      reconciliation_persisted: reconciliation.persisted,
      reconciliation_error: reconciliation.error,
      lead_id: lead.id,
      gmail_message_id: sent.id,
      gmail_thread_id: sent.threadId || lead.gmail_thread_id,
      lead_status: reconciliation.persisted ? 'reconciliation_required' : 'sent',
    }, 502);
  }

  return json({
    ok: true,
    email_sent: true,
    retry_safe: false,
    reconciliation_required: false,
    lead_id: lead.id,
    gmail_message_id: sent.id,
    gmail_thread_id: sent.threadId || lead.gmail_thread_id,
    follow_up_step: followUpStep,
    next_follow_up_at: nextFollowUpAt,
    sequence_complete: sequenceComplete,
  });
});
