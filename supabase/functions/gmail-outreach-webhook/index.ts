import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { createClient } from 'npm:@supabase/supabase-js@2';

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
  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: String(Deno.env.get('GMAIL_CLIENT_ID') || ''),
      client_secret: String(Deno.env.get('GMAIL_CLIENT_SECRET') || ''),
      refresh_token: await decryptRefreshToken(mailbox),
      grant_type: 'refresh_token',
    }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || !body.access_token) throw new Error(String(body.error_description || body.error));
  return String(body.access_token);
}

async function gmail(token: string, path: string) {
  const response = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me${path}`, {
    headers: { Authorization: `Bearer ${token}` },
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
    const db = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });
    const { data: state } = await db
      .from('outreach_mailbox_state')
      .select('*')
      .eq('mailbox_email', senderEmail)
      .eq('is_active', true)
      .maybeSingle();
    if (!state) return json({ ok: true, ignored: true });
    const newHistoryId = String(notification.historyId || '');
    if (!state?.gmail_history_id) {
      await db.from('outreach_mailbox_state').upsert({
        mailbox_email: senderEmail,
        gmail_history_id: newHistoryId,
        updated_at: new Date().toISOString(),
      });
      return json({ ok: true, initialised: true });
    }

    const token = await accessToken(state);
    const history = await gmail(
      token,
      `/history?startHistoryId=${encodeURIComponent(state.gmail_history_id)}&historyTypes=messageAdded`,
    );
    const messageIds = [...new Set((history.history || [])
      .flatMap((item: any) => item.messagesAdded || [])
      .map((item: any) => String(item?.message?.id || ''))
      .filter(Boolean))];
    let processed = 0;

    for (const messageId of messageIds) {
      const message = await gmail(token, `/messages/${encodeURIComponent(messageId)}?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Subject`);
      const from = emailFromHeader(header(message, 'From'));
      if (!from || from === senderEmail) continue;
      const { data: lead } = await db
        .from('outreach_leads')
        .select('*')
        .eq('gmail_thread_id', String(message.threadId || ''))
        .maybeSingle();
      if (!lead) continue;

      const fromLower = from.toLowerCase();
      const snippet = String(message.snippet || '').trim();
      const isBounce = /mailer-daemon|postmaster|mail delivery subsystem/i.test(fromLower)
        || /delivery status notification|undeliverable|delivery failed/i.test(header(message, 'Subject'));
      const isOptOut = /\b(unsubscribe|remove me|do not contact|stop emailing)\b/i.test(snippet);
      const nextStatus = isBounce ? 'bounced' : isOptOut ? 'suppressed' : 'replied';
      const now = new Date().toISOString();

      await db.from('outreach_communications').upsert({
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
        occurred_at: message.internalDate ? new Date(Number(message.internalDate)).toISOString() : now,
        created_by: lead.approved_by || lead.created_by,
      }, { onConflict: 'provider,provider_message_id' });

      await db.from('outreach_leads').update({
        status: nextStatus,
        follow_up_enabled: false,
        next_follow_up_at: null,
        last_reply_at: !isBounce && !isOptOut ? now : lead.last_reply_at,
        last_bounce_at: isBounce ? now : lead.last_bounce_at,
        last_unsubscribe_at: isOptOut ? now : lead.last_unsubscribe_at,
        updated_at: now,
      }).eq('id', lead.id);

      if (isOptOut) {
        await db.from('outreach_suppressions').upsert({
          email: String(lead.recipient_email || '').toLowerCase(),
          reason: 'Recipient requested no further contact',
          source: 'gmail-reply',
          created_by: lead.approved_by || lead.created_by,
        }, { onConflict: 'email' });
      }
      processed += 1;
    }

    await db.from('outreach_mailbox_state').upsert({
      mailbox_email: senderEmail,
      gmail_history_id: String(history.historyId || newHistoryId),
      updated_at: new Date().toISOString(),
    });
    return json({ ok: true, processed });
  } catch (error) {
    return json({ error: String(error instanceof Error ? error.message : error) }, 502);
  }
});
