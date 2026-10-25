
alter table public.outreach_leads
  add column if not exists reply_outcome text,
  add column if not exists reply_outcome_confidence numeric,
  add column if not exists reply_outcome_evidence text,
  add column if not exists reply_message_id text,
  add column if not exists outcome_processed_at timestamptz,
  add column if not exists outcome_action_status text,
  add column if not exists outcome_action_error text,
  add column if not exists attio_deal_record_id text,
  add column if not exists attio_deal_url text;

alter table public.outreach_leads
  drop constraint if exists outreach_leads_reply_outcome_check,
  add constraint outreach_leads_reply_outcome_check
    check (reply_outcome is null or reply_outcome = any (array[
      'positive'::text,
      'negative'::text,
      'manual_review'::text
    ])),
  drop constraint if exists outreach_leads_reply_outcome_confidence_check,
  add constraint outreach_leads_reply_outcome_confidence_check
    check (
      reply_outcome_confidence is null
      or (reply_outcome_confidence >= 0 and reply_outcome_confidence <= 1)
    ),
  drop constraint if exists outreach_leads_outcome_action_status_check,
  add constraint outreach_leads_outcome_action_status_check
    check (
      outcome_action_status is null
      or outcome_action_status = any (array[
        'pending'::text,
        'completed'::text,
        'error'::text,
        'not_required'::text
      ])
    );

alter table public.ccs_projects
  add column if not exists outreach_disposition text not null default 'open',
  add column if not exists outreach_closed_at timestamptz,
  add column if not exists outreach_close_reason text;

alter table public.ccs_projects
  drop constraint if exists ccs_projects_outreach_disposition_check,
  add constraint ccs_projects_outreach_disposition_check
    check (outreach_disposition = any (array[
      'open'::text,
      'deal_created'::text,
      'dead'::text,
      'manual_review'::text
    ]));

create table if not exists public.outreach_reply_outcomes (
  id uuid primary key default gen_random_uuid(),
  outreach_lead_id uuid not null
    references public.outreach_leads(id) on delete cascade,
  project_id text not null
    references public.ccs_projects(project_id) on delete restrict,
  provider_message_id text not null unique,
  outcome text not null
    check (outcome = any (array[
      'positive'::text,
      'negative'::text,
      'manual_review'::text
    ])),
  confidence numeric not null
    check (confidence >= 0 and confidence <= 1),
  evidence text not null,
  reply_excerpt text,
  action_status text not null default 'pending'
    check (action_status = any (array[
      'pending'::text,
      'completed'::text,
      'error'::text,
      'not_required'::text
    ])),
  action_error text,
  attio_deal_record_id text,
  attio_deal_url text,
  created_at timestamptz not null default now(),
  processed_at timestamptz
);

comment on table public.outreach_reply_outcomes is
  'Server-created audit trail for deterministic SiteFinder outreach reply classification and CRM actions.';
comment on column public.ccs_projects.outreach_disposition is
  'Sales-outreach state; separate from CCS source activity so source refreshes cannot reopen a dead outreach item.';

create index if not exists outreach_reply_outcomes_lead_created_idx
  on public.outreach_reply_outcomes (outreach_lead_id, created_at desc);
create index if not exists outreach_reply_outcomes_project_created_idx
  on public.outreach_reply_outcomes (project_id, created_at desc);
create index if not exists outreach_leads_reply_outcome_idx
  on public.outreach_leads (reply_outcome, outcome_action_status);
create index if not exists ccs_projects_outreach_disposition_idx
  on public.ccs_projects (outreach_disposition);

alter table public.outreach_reply_outcomes enable row level security;

drop policy if exists "GSD employees read outreach reply outcomes"
  on public.outreach_reply_outcomes;
create policy "GSD employees read outreach reply outcomes"
  on public.outreach_reply_outcomes
  for select
  to authenticated
  using (
    lower(coalesce((select auth.jwt()) ->> 'email', ''))
      like '%@gsdecorating.com'
  );

revoke all on table public.outreach_reply_outcomes from anon;
grant select on table public.outreach_reply_outcomes to authenticated;
