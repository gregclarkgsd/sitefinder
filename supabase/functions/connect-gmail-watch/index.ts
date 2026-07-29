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

async function accessToken(mailbox: any) {
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
  if (!response.ok || !body.access_token) throw new Error(String(body.error_description || body.error));
  return String(body.access_token);
}

Deno.serve(async req => {
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY');
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  const topicName = Deno.env.get('GMAIL_PUBSUB_TOPIC');
  if (!supabaseUrl || !anonKey || !serviceKey || !topicName) {
    return json({ error: 'Gmail watch is not fully configured' }, 503);
  }
  const userClient = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: req.headers.get('Authorization') || '' } },
    auth: { persistSession: false },
  });
  const { data: userData, error: userError } = await userClient.auth.getUser();
  if (userError || !String(userData.user?.email || '').toLowerCase().endsWith('@gsdecorating.com')) {
    return json({ error: 'Authorised GSD account required' }, 403);
  }
  try {
    const requestBody = await req.json().catch(() => ({}));
    const mailboxEmail = String(requestBody.mailbox_email || '').trim().toLowerCase();
    const db = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });
    const { data: mailbox } = await db
      .from('outreach_mailbox_state')
      .select('*')
      .eq('mailbox_email', mailboxEmail)
      .eq('is_active', true)
      .maybeSingle();
    if (!mailbox) return json({ error: 'Connected GSD mailbox not found' }, 404);
    const token = await accessToken(mailbox);
    const response = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/watch', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ topicName, labelIds: ['INBOX'], labelFilterBehavior: 'include' }),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(String(body?.error?.message || `Gmail returned ${response.status}`));
    await db.from('outreach_mailbox_state').upsert({
      mailbox_email: mailboxEmail,
      gmail_history_id: String(body.historyId || ''),
      watch_expiration: body.expiration ? new Date(Number(body.expiration)).toISOString() : null,
      updated_at: new Date().toISOString(),
    });
    return json({ ok: true, mailbox_email: mailboxEmail, watch_expiration: body.expiration || null });
  } catch (error) {
    return json({ error: String(error instanceof Error ? error.message : error) }, 502);
  }
});
