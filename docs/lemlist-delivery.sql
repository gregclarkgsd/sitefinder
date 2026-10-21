-- Unapplied local-test design. Install after capture, guard and worker designs.
begin;
create table private.lemlist_dispatch (
  event_id uuid primary key references private.lemlist_insert_events(id),
  state text not null check(state in ('pending','processing','reviewed','held')),
  claimed_at timestamptz,
  generation integer not null default 0,
  created_at timestamptz not null default clock_timestamp()
);
create table private.lemlist_stop_outbox (
  event_id text primary key references private.lemlist_events(event_id),
  lead_id uuid not null,
  campaign_id text not null,
  recipient_email text not null,
  provider_lead_id text,
  state text not null default 'pending' check(state in ('pending','processing','retry','confirmed','quarantined')),
  attempts integer not null default 0 check(attempts>=0),
  next_attempt_at timestamptz not null default clock_timestamp(),
  claimed_at timestamptz,
  generation integer not null default 0,
  last_error_code text,
  created_at timestamptz not null default clock_timestamp()
);
create table private.lemlist_event_inbox (
  event_id text primary key,
  event_hash text not null,
  normalized_event jsonb not null,
  state text not null check(state in ('pending','processing','processed','quarantined')),
  claimed_at timestamptz,
  generation integer not null default 0,
  last_error_code text,
  created_at timestamptz not null default clock_timestamp()
);
alter table private.lemlist_dispatch enable row level security;
alter table private.lemlist_stop_outbox enable row level security;
alter table private.lemlist_event_inbox enable row level security;
revoke all on private.lemlist_dispatch,private.lemlist_stop_outbox,private.lemlist_event_inbox from public,anon,authenticated;
commit;
