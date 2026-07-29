import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { createClient } from 'npm:@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

function bytesToBase64(bytes: Uint8Array) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

async function digest(value: string) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

async function encryptionKey() {
  const secret = Deno.env.get('MAILBOX_ENCRYPTION_KEY');
  if (!secret || secret.length < 32) throw new Error('Mailbox encryption is not configured');
  const keyBytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret));
  return crypto.subtle.importKey('raw', keyBytes, 'AES-GCM', false, ['encrypt']);
}

async function encryptRefreshToken(refreshToken: string) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    await encryptionKey(),
    new TextEncoder().encode(refreshToken),
  );
  return {
    refresh_token_ciphertext: bytesToBase64(new Uint8Array(ciphertext)),
    refresh_token_iv: bytesToBase64(iv),
  };
}

async function authorisedUser(req: Request, supabaseUrl: string, anonKey: string) {
  const client = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: req.headers.get('Authorization') || '' } },
    auth: { persistSession: false },
  });
  const { data, error } = await client.auth.getUser();
  const email = String(data.user?.email || '').toLowerCase();
  if (error || !data.user || !email.endsWith('@gsdecorating.com')) return null;
  return { id: data.user.id, email };
}

Deno.serve(async req => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY');
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  const clientId = Deno.env.get('GMAIL_CLIENT_ID');
  const clientSecret = Deno.env.get('GMAIL_CLIENT_SECRET');
  const topicName = Deno.env.get('GMAIL_PUBSUB_TOPIC');
  const sitefinderUrl = Deno.env.get('SITEFINDER_URL') || 'https://gsd-sitefinder.onrender.com';
  if (!supabaseUrl || !anonKey || !serviceKey) return json({ error: 'Mailbox service is not configured' }, 503);
  const db = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });
  const redirectUri = `${supabaseUrl}/functions/v1/gmail-mailboxes`;

  if (req.method === 'GET') {
    const url = new URL(req.url);
    const code = url.searchParams.get('code');
    const state = url.searchParams.get('state');
    if (!code || !state || !clientId || !clientSecret || !topicName) {
      return new Response('Invalid Gmail OAuth callback', { status: 400 });
    }
    const stateHash = await digest(state);
    const { data: oauthState } = await db
      .from('outreach_oauth_states')
      .select('*')
      .eq('state_hash', stateHash)
      .gt('expires_at', new Date().toISOString())
      .maybeSingle();
    if (!oauthState) return new Response('This Gmail connection link has expired or was already used.', { status: 400 });
    await db.from('outreach_oauth_states').delete().eq('state_hash', stateHash);

    try {
      const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: clientId,
          client_secret: clientSecret,
          code,
          redirect_uri: redirectUri,
          grant_type: 'authorization_code',
        }),
      });
      const tokens = await tokenResponse.json().catch(() => ({}));
      if (!tokenResponse.ok || !tokens.access_token || !tokens.refresh_token) {
        throw new Error(String(tokens.error_description || tokens.error || 'Google did not return an offline mailbox connection'));
      }
      const profileResponse = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
        headers: { Authorization: `Bearer ${tokens.access_token}` },
      });
      const profile = await profileResponse.json().catch(() => ({}));
      const mailboxEmail = String(profile.email || '').trim().toLowerCase();
      if (!profileResponse.ok || !mailboxEmail.endsWith('@gsdecorating.com')) {
        throw new Error('Only a @gsdecorating.com mailbox can be connected');
      }
      const encrypted = await encryptRefreshToken(String(tokens.refresh_token));
      const watchResponse = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/watch', {
        method: 'POST',
        headers: { Authorization: `Bearer ${tokens.access_token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ topicName, labelIds: ['INBOX'], labelFilterBehavior: 'include' }),
      });
      const watch = await watchResponse.json().catch(() => ({}));
      if (!watchResponse.ok) throw new Error(String(watch?.error?.message || 'Could not start Gmail reply tracking'));

      const { error: saveError } = await db.from('outreach_mailbox_state').upsert({
        mailbox_email: mailboxEmail,
        connected_by: oauthState.requested_by,
        display_name: String(profile.name || mailboxEmail),
        ...encrypted,
        is_active: true,
        connected_at: new Date().toISOString(),
        gmail_history_id: String(watch.historyId || ''),
        watch_expiration: watch.expiration ? new Date(Number(watch.expiration)).toISOString() : null,
        last_error: null,
        updated_at: new Date().toISOString(),
      });
      if (saveError) throw saveError;
      return Response.redirect(`${oauthState.return_to}?gmail=connected&mailbox=${encodeURIComponent(mailboxEmail)}`, 302);
    } catch (error) {
      const message = String(error instanceof Error ? error.message : error).slice(0, 500);
      return Response.redirect(`${oauthState.return_to}?gmail=error&message=${encodeURIComponent(message)}`, 302);
    }
  }

  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  const user = await authorisedUser(req, supabaseUrl, anonKey);
  if (!user) return json({ error: 'Authorised GSD account required' }, 403);
  const requestBody = await req.json().catch(() => ({}));
  const action = String(requestBody.action || 'list');

  if (action === 'list') {
    const { data, error } = await db
      .from('outreach_mailbox_state')
      .select('mailbox_email,display_name,is_active,connected_at,watch_expiration,last_error')
      .eq('is_active', true)
      .order('mailbox_email');
    if (error) return json({ error: error.message }, 502);
    return json({ mailboxes: data || [] });
  }

  if (action === 'begin') {
    if (!clientId || !clientSecret || !topicName) return json({ error: 'Google OAuth is not configured yet' }, 503);
    await encryptionKey();
    const state = bytesToBase64(crypto.getRandomValues(new Uint8Array(32)))
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
    await db.from('outreach_oauth_states').delete().lt('expires_at', new Date().toISOString());
    const { error } = await db.from('outreach_oauth_states').insert({
      state_hash: await digest(state),
      requested_by: user.id,
      return_to: `${sitefinderUrl}/?view=outreach`,
      expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
    });
    if (error) return json({ error: error.message }, 502);
    const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    authUrl.search = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      access_type: 'offline',
      prompt: 'consent select_account',
      login_hint: user.email,
      scope: [
        'openid',
        'email',
        'profile',
        'https://www.googleapis.com/auth/gmail.modify',
        'https://www.googleapis.com/auth/gmail.send',
      ].join(' '),
      state,
    }).toString();
    return json({ auth_url: authUrl.toString() });
  }

  if (action === 'disconnect') {
    const mailboxEmail = String(requestBody.mailbox_email || '').trim().toLowerCase();
    if (!mailboxEmail.endsWith('@gsdecorating.com')) return json({ error: 'Valid GSD mailbox required' }, 400);
    const { error } = await db.from('outreach_mailbox_state').update({
      is_active: false,
      refresh_token_ciphertext: null,
      refresh_token_iv: null,
      gmail_history_id: null,
      watch_expiration: null,
      updated_at: new Date().toISOString(),
    }).eq('mailbox_email', mailboxEmail);
    if (error) return json({ error: error.message }, 502);
    return json({ ok: true });
  }

  return json({ error: 'Unknown action' }, 400);
});
