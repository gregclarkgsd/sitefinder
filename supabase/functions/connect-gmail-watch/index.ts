import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { createClient } from 'npm:@supabase/supabase-js@2.110.7';
import { corsHeaders } from 'npm:@supabase/supabase-js@2.110.7/cors';
import { watchRenewalUpdate } from '../_shared/gmail-reliability.js';

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
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
    signal: AbortSignal.timeout(20_000),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || !body.access_token) {
    throw new Error(String(body.error_description || body.error || 'Could not connect to GSD Gmail'));
  }
  return String(body.access_token);
}

async function renewMailbox(db: any, mailbox: any, topicName: string) {
  const mailboxEmail = String(mailbox.mailbox_email || '').trim().toLowerCase();
  try {
    const token = await accessToken(mailbox);
    const response = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/watch', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ topicName, labelIds: ['INBOX'], labelFilterBehavior: 'include' }),
      signal: AbortSignal.timeout(25_000),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(String(body?.error?.message || `Gmail returned ${response.status}`));
    }

    const update = watchRenewalUpdate(body, new Date().toISOString());
    const { data, error } = await db
      .from('outreach_mailbox_state')
      .update(update)
      .eq('mailbox_email', mailboxEmail)
      .eq('is_active', true)
      .select('mailbox_email')
      .maybeSingle();
    if (error) throw new Error(`Could not persist Gmail watch renewal: ${error.message}`);
    if (!data) throw new Error('Mailbox changed or disconnected before watch renewal was saved');

    return {
      ok: true,
      mailbox_email: mailboxEmail,
      watch_expiration: update.watch_expiration,
    };
  } catch (error) {
    const message = String(error instanceof Error ? error.message : error).slice(0, 1000);
    const { data, error: persistenceError } = await db
      .from('outreach_mailbox_state')
      .update({
        last_error: message,
        updated_at: new Date().toISOString(),
      })
      .eq('mailbox_email', mailboxEmail)
      .eq('is_active', true)
      .select('mailbox_email')
      .maybeSingle();
    return {
      ok: false,
      mailbox_email: mailboxEmail,
      error: message,
      error_persisted: Boolean(data) && !persistenceError,
      ...(persistenceError
        ? { persistence_error: `Could not save mailbox error: ${persistenceError.message}` }
        : !data
          ? { persistence_error: 'Mailbox changed or disconnected before its error could be saved' }
          : {}),
    };
  }
}

Deno.serve(async req => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY');
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  const topicName = Deno.env.get('GMAIL_PUBSUB_TOPIC');
  if (!supabaseUrl || !anonKey || !serviceKey || !topicName) {
    return json({ error: 'Gmail watch is not fully configured' }, 503);
  }

  const configuredCronSecret = Deno.env.get('OUTREACH_CRON_SECRET');
  const suppliedCronSecret = req.headers.get('x-sitefinder-cron-secret');
  const isCron = Boolean(
    configuredCronSecret
    && suppliedCronSecret
    && suppliedCronSecret === configuredCronSecret,
  );
  if (!isCron) {
    const userClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: req.headers.get('Authorization') || '' } },
      auth: { persistSession: false },
    });
    const { data: userData, error: userError } = await userClient.auth.getUser();
    if (
      userError
      || !String(userData.user?.email || '').toLowerCase().endsWith('@gsdecorating.com')
    ) {
      return json({ error: 'Authorised GSD account required' }, 403);
    }
  }

  try {
    const requestBody = await req.json().catch(() => ({}));
    const db = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });
    let mailboxes: any[] = [];
    if (isCron) {
      const { data, error } = await db
        .from('outreach_mailbox_state')
        .select('*')
        .eq('is_active', true)
        .order('mailbox_email');
      if (error) return json({ error: `Could not load active Gmail mailboxes: ${error.message}` }, 502);
      mailboxes = data || [];
    } else {
      const mailboxEmail = String(requestBody.mailbox_email || '').trim().toLowerCase();
      if (!mailboxEmail.endsWith('@gsdecorating.com')) {
        return json({ error: 'Valid GSD mailbox required' }, 400);
      }
      const { data, error } = await db
        .from('outreach_mailbox_state')
        .select('*')
        .eq('mailbox_email', mailboxEmail)
        .eq('is_active', true)
        .maybeSingle();
      if (error) return json({ error: `Could not load connected Gmail mailbox: ${error.message}` }, 502);
      if (!data) return json({ error: 'Connected GSD mailbox not found' }, 404);
      mailboxes = [data];
    }

    const results = await Promise.all(
      mailboxes.map(mailbox => renewMailbox(db, mailbox, topicName)),
    );
    const renewed = results.filter(result => result.ok).length;
    const failed = results.length - renewed;
    const singleResult = !isCron ? results[0] : null;
    return json({
      ok: failed === 0,
      partial: renewed > 0 && failed > 0,
      mode: isCron ? 'cron' : 'user',
      requested: results.length,
      renewed,
      failed,
      results,
      ...(singleResult
        ? {
            mailbox_email: singleResult.mailbox_email,
            ...(singleResult.watch_expiration
              ? { watch_expiration: singleResult.watch_expiration }
              : {}),
            ...(singleResult.error ? { error: singleResult.error } : {}),
          }
        : {}),
    }, failed ? 502 : 200);
  } catch (error) {
    return json({ error: String(error instanceof Error ? error.message : error) }, 502);
  }
});
