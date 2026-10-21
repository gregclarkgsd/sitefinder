-- Unapplied design; synthetic tests only. Apply after the two other design scripts.
begin;
create table private.lemlist_attempts (
  lead_id uuid primary key,
  campaign_id text not null,
  recipient_email text not null,
  payload_hash text not null,
  payload jsonb not null,
  state text not null check (state in ('uncertain','confirmed','held')),
  provider_id text,
  created_at timestamptz not null default clock_timestamp()
);
create table private.lemlist_events (
  event_id text primary key,
  event_hash text not null,
  campaign_id text not null,
  recipient_email text not null,
  kind text not null check (kind in ('reply','bounce','unsubscribe')),
  occurred_at timestamptz not null,
  received_at timestamptz not null default clock_timestamp()
);
alter table private.lemlist_attempts enable row level security;
alter table private.lemlist_events enable row level security;
revoke all on private.lemlist_attempts, private.lemlist_events from public, anon, authenticated;
-- No client grants or runnable HTTP endpoint. An approved server-side transaction
-- adapter is still needed. Claims and event history must never be auto-released.
commit;
