alter table public.outreach_leads
  add column if not exists attio_company_record_id text,
  add column if not exists attio_person_record_id text,
  add column if not exists follow_up_enabled boolean not null default true,
  add column if not exists follow_up_step integer not null default 0,
  add column if not exists next_follow_up_at timestamptz,
  add column if not exists gmail_message_id text,
  add column if not exists gmail_thread_id text,
  add column if not exists gmail_rfc_message_id text,
  add column if not exists last_reply_at timestamptz,
  add column if not exists last_bounce_at timestamptz,
  add column if not exists last_unsubscribe_at timestamptz;

alter table public.outreach_leads
  drop constraint if exists outreach_leads_status_check;

alter table public.outreach_leads
  add constraint outreach_leads_status_check
  check (status in (
    'queued','reviewing','approved','sent','followup_due','skipped',
    'replied','bounced','failed','suppressed'
  ));

create index if not exists outreach_leads_followup_due_idx
  on public.outreach_leads(next_follow_up_at)
  where follow_up_enabled
    and status in ('sent','followup_due')
    and next_follow_up_at is not null;

create index if not exists outreach_leads_gmail_thread_idx
  on public.outreach_leads(gmail_thread_id)
  where gmail_thread_id is not null;

comment on column public.outreach_leads.attio_record_id is
  'Attio Projects custom-object record ID. This is never an Attio Deal ID.';
comment on column public.outreach_leads.attio_company_record_id is
  'Matched or safely created Attio company record ID.';
comment on column public.outreach_leads.attio_person_record_id is
  'Matched or safely created Attio person record ID.';
comment on column public.outreach_leads.next_follow_up_at is
  'Next approved chase date. Cleared immediately after reply, bounce, opt-out or suppression.';

create table if not exists public.outreach_mailbox_state (
  mailbox_email text primary key,
  gmail_history_id text,
  watch_expiration timestamptz,
  updated_at timestamptz not null default now()
);

alter table public.outreach_mailbox_state enable row level security;
revoke all on public.outreach_mailbox_state from anon, authenticated;
