create table if not exists public.ccs_projects (
  project_id text primary key,
  project_name text not null,
  main_contractor text,
  client text,
  local_authority text,
  latitude double precision,
  longitude double precision,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  last_changed_at timestamptz not null default now(),
  discovered_after_baseline boolean not null default true,
  is_active boolean not null default true,
  payload_hash text not null,
  source_data jsonb not null default '{}'::jsonb
);

create index if not exists ccs_projects_active_seen_idx
  on public.ccs_projects (is_active, first_seen_at desc);

create table if not exists public.ccs_sync_runs (
  id bigint generated always as identity primary key,
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  status text not null default 'running' check (status in ('running','completed','failed')),
  total_projects integer not null default 0,
  new_projects integer not null default 0,
  changed_projects integer not null default 0,
  error_message text
);

create table if not exists public.lead_tracking (
  project_id text primary key,
  stage text not null default 'new' check (stage in ('new','reviewing','contacted','quoting','won','lost')),
  assigned_to uuid references auth.users(id) on delete set null,
  assigned_email text,
  next_action text,
  next_action_at timestamptz,
  updated_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz not null default now()
);

alter table public.ccs_projects enable row level security;
alter table public.ccs_sync_runs enable row level security;
alter table public.lead_tracking enable row level security;

revoke all on public.ccs_projects from anon;
revoke all on public.ccs_sync_runs from anon;
revoke all on public.lead_tracking from anon;
grant select on public.ccs_projects to authenticated;
grant select on public.ccs_sync_runs to authenticated;
grant select, insert, update, delete on public.lead_tracking to authenticated;

create policy "GSD employees read CCS history"
on public.ccs_projects for select to authenticated
using (lower(coalesce(auth.jwt() ->> 'email','')) like '%@gsdecorating.com');

create policy "GSD employees read sync history"
on public.ccs_sync_runs for select to authenticated
using (lower(coalesce(auth.jwt() ->> 'email','')) like '%@gsdecorating.com');

create policy "GSD employees read lead tracking"
on public.lead_tracking for select to authenticated
using (lower(coalesce(auth.jwt() ->> 'email','')) like '%@gsdecorating.com');

create policy "GSD employees add lead tracking"
on public.lead_tracking for insert to authenticated
with check (
  lower(coalesce(auth.jwt() ->> 'email','')) like '%@gsdecorating.com'
  and updated_by = (select auth.uid())
);

create policy "GSD employees update lead tracking"
on public.lead_tracking for update to authenticated
using (lower(coalesce(auth.jwt() ->> 'email','')) like '%@gsdecorating.com')
with check (
  lower(coalesce(auth.jwt() ->> 'email','')) like '%@gsdecorating.com'
  and updated_by = (select auth.uid())
);

create policy "GSD employees delete lead tracking"
on public.lead_tracking for delete to authenticated
using (lower(coalesce(auth.jwt() ->> 'email','')) like '%@gsdecorating.com');
