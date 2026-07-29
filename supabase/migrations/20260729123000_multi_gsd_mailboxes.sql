alter table public.outreach_mailbox_state
  add column if not exists connected_by uuid references auth.users(id) on delete set null,
  add column if not exists display_name text,
  add column if not exists refresh_token_ciphertext text,
  add column if not exists refresh_token_iv text,
  add column if not exists is_active boolean not null default true,
  add column if not exists connected_at timestamptz,
  add column if not exists last_error text;

comment on table public.outreach_mailbox_state is
  'Private server-only Gmail mailbox credentials and watch cursors. Never exposed through the Data API.';
comment on column public.outreach_mailbox_state.refresh_token_ciphertext is
  'AES-GCM encrypted Google OAuth refresh token. Requires the server-only MAILBOX_ENCRYPTION_KEY to decrypt.';

create index if not exists outreach_mailbox_state_active_idx
  on public.outreach_mailbox_state(is_active, mailbox_email)
  where is_active;

create table if not exists public.outreach_oauth_states (
  state_hash text primary key,
  requested_by uuid not null references auth.users(id) on delete cascade,
  return_to text not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

alter table public.outreach_oauth_states enable row level security;
revoke all on public.outreach_oauth_states from anon, authenticated;

create index if not exists outreach_oauth_states_expiry_idx
  on public.outreach_oauth_states(expires_at);

comment on table public.outreach_oauth_states is
  'Short-lived, single-use OAuth state records used by the Gmail mailbox callback.';
