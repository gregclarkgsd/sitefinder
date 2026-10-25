import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { createClient } from 'npm:@supabase/supabase-js@2';

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
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

async function getAccessToken(mailbox: any) {
  const clientId = Deno.env.get('GMAIL_CLIENT_ID');
  const clientSecret = Deno.env.get('GMAIL_CLIENT_SECRET');
  const refreshToken = await decryptRefreshToken(mailbox);
  if (!clientId || !clientSecret || !refreshToken) throw new Error('GSD Gmail OAuth is not configured');
  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || !body.access_token) throw new Error(String(body.error_description || body.error || 'Token refresh failed'));
  return String(body.access_token);
}

Deno.serve(async req => {
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  const cronSecret = Deno.env.get('OUTREACH_CRON_SECRET');
  if (!cronSecret || req.headers.get('x-sitefinder-cron-secret') !== cronSecret) {
    return json({ error: 'Unauthorised' }, 401);
  }
  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  const topicName = Deno.env.get('GMAIL_PUBSUB_TOPIC');
  if (!supabaseUrl || !serviceKey || !topicName) return json({ error: 'Gmail watch is not fully configured' }, 503);

  const db = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });
  const { data: mailboxes, error } = await db
    .from('outreach_mailbox_state')
    .select('*')
    .eq('is_active', true);
  if (error) return json({ error: error.message }, 502);

  const results = [];
  for (const mailbox of mailboxes || []) {
    try {
      const token = await getAccessToken(mailbox);
      const response = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/watch', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ topicName, labelIds: ['INBOX'], labelFilterBehavior: 'include' }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(String(body?.error?.message || `Gmail returned ${response.status}`));
      const watchExpiration = body.expiration ? new Date(Number(body.expiration)).toISOString() : null;
      await db.from('outreach_mailbox_state').update({
        gmail_history_id: String(body.historyId || mailbox.gmail_history_id || ''),
        watch_expiration: watchExpiration,
        last_error: null,
        updated_at: new Date().toISOString(),
      }).eq('mailbox_email', mailbox.mailbox_email);
      results.push({ mailbox_email: mailbox.mailbox_email, ok: true, watch_expiration: watchExpiration });
    } catch (watchError) {
      const message = String(watchError instanceof Error ? watchError.message : watchError);
      await db.from('outreach_mailbox_state').update({
        last_error: message,
        updated_at: new Date().toISOString(),
      }).eq('mailbox_email', mailbox.mailbox_email);
      results.push({ mailbox_email: mailbox.mailbox_email, ok: false, error: message });
    }
  }

  return json({ ok: results.every(result => result.ok), processed: results.length, results });
});
