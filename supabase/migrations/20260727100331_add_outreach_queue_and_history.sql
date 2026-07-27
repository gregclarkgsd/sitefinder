create table if not exists public.outreach_leads (
  id uuid primary key default gen_random_uuid(),
  project_id text not null unique references public.ccs_projects(project_id) on delete cascade,
  project_name text not null,
  recipient_email text,
  recipient_name text,
  company_name text,
  status text not null default 'queued'
    check (status in ('queued','reviewing','approved','sent','skipped','replied','bounced','failed','suppressed')),
  email_subject text,
  email_body text,
  sender_email text,
  approved_by uuid references auth.users(id) on delete set null,
  approved_at timestamptz,
  skipped_at timestamptz,
  sent_at timestamptz,
  attio_record_id text,
  created_by uuid references auth.users(id) on delete set null,
  updated_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists outreach_leads_status_created_idx
  on public.outreach_leads(status, created_at desc);
create index if not exists outreach_leads_recipient_idx
  on public.outreach_leads(lower(recipient_email))
  where recipient_email is not null;

create table if not exists public.outreach_communications (
  id uuid primary key default gen_random_uuid(),
  project_id text not null references public.ccs_projects(project_id) on delete cascade,
  outreach_lead_id uuid references public.outreach_leads(id) on delete set null,
  direction text not null check (direction in ('outbound','inbound','internal')),
  channel text not null check (channel in ('email','phone','note')),
  status text not null default 'logged'
    check (status in ('draft','approved','queued','sent','delivered','received','replied','bounced','failed','logged')),
  sender_email text,
  recipient_email text,
  subject text,
  body text,
  provider text,
  provider_message_id text,
  occurred_at timestamptz not null default now(),
  created_by uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);

create index if not exists outreach_communications_project_time_idx
  on public.outreach_communications(project_id, occurred_at desc);
create unique index if not exists outreach_communications_provider_message_idx
  on public.outreach_communications(provider, provider_message_id)
  where provider_message_id is not null;

create table if not exists public.outreach_suppressions (
  id uuid primary key default gen_random_uuid(),
  email text not null check (email = lower(email)),
  reason text not null,
  source text not null default 'manual',
  created_by uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);

create unique index if not exists outreach_suppressions_email_idx
  on public.outreach_suppressions(email);

alter table public.outreach_leads enable row level security;
alter table public.outreach_communications enable row level security;
alter table public.outreach_suppressions enable row level security;

revoke all on public.outreach_leads from anon;
revoke all on public.outreach_communications from anon;
revoke all on public.outreach_suppressions from anon;

grant select, insert, update, delete on public.outreach_leads to authenticated;
grant select, insert on public.outreach_communications to authenticated;
grant select, insert, update, delete on public.outreach_suppressions to authenticated;

create policy "GSD employees read outreach leads"
on public.outreach_leads for select to authenticated
using (lower(coalesce(auth.jwt() ->> 'email','')) like '%@gsdecorating.com');

create policy "GSD employees create outreach leads"
on public.outreach_leads for insert to authenticated
with check (
  lower(coalesce(auth.jwt() ->> 'email','')) like '%@gsdecorating.com'
  and created_by = (select auth.uid())
);

create policy "GSD employees update outreach leads"
on public.outreach_leads for update to authenticated
using (lower(coalesce(auth.jwt() ->> 'email','')) like '%@gsdecorating.com')
with check (
  lower(coalesce(auth.jwt() ->> 'email','')) like '%@gsdecorating.com'
  and updated_by = (select auth.uid())
);

create policy "GSD employees delete outreach leads"
on public.outreach_leads for delete to authenticated
using (lower(coalesce(auth.jwt() ->> 'email','')) like '%@gsdecorating.com');

create policy "GSD employees read outreach communications"
on public.outreach_communications for select to authenticated
using (lower(coalesce(auth.jwt() ->> 'email','')) like '%@gsdecorating.com');

create policy "GSD employees log outreach communications"
on public.outreach_communications for insert to authenticated
with check (
  lower(coalesce(auth.jwt() ->> 'email','')) like '%@gsdecorating.com'
  and created_by = (select auth.uid())
);

create policy "GSD employees read outreach suppressions"
on public.outreach_suppressions for select to authenticated
using (lower(coalesce(auth.jwt() ->> 'email','')) like '%@gsdecorating.com');

create policy "GSD employees create outreach suppressions"
on public.outreach_suppressions for insert to authenticated
with check (
  lower(coalesce(auth.jwt() ->> 'email','')) like '%@gsdecorating.com'
  and created_by = (select auth.uid())
);

create policy "GSD employees update outreach suppressions"
on public.outreach_suppressions for update to authenticated
using (lower(coalesce(auth.jwt() ->> 'email','')) like '%@gsdecorating.com')
with check (
  lower(coalesce(auth.jwt() ->> 'email','')) like '%@gsdecorating.com'
  and created_by = (select auth.uid())
);

create policy "GSD employees delete outreach suppressions"
on public.outreach_suppressions for delete to authenticated
using (lower(coalesce(auth.jwt() ->> 'email','')) like '%@gsdecorating.com');
