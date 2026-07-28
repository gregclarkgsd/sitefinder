-- Read-only research observability and human review state for GSD SiteFinder.
create table public.research_runs (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(trim(name)) between 1 and 120),
  mode text not null default 'read_only'
    check (mode = 'read_only'),
  source text not null default 'attio'
    check (source in ('attio', 'pipedrive', 'file')),
  status text not null default 'queued'
    check (status in (
      'queued',
      'running',
      'paused',
      'stopping',
      'completed',
      'failed',
      'cancelled'
    )),
  company_limit integer not null
    check (company_limit between 1 and 250),
  companies_checked integer not null default 0
    check (companies_checked >= 0),
  pages_inspected integer not null default 0
    check (pages_inspected >= 0),
  people_found integer not null default 0
    check (people_found >= 0),
  configuration jsonb not null default '{}'::jsonb,
  failure_message text,
  started_at timestamptz,
  completed_at timestamptz,
  created_by uuid references auth.users(id),
  updated_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.research_tasks (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references public.research_runs(id) on delete cascade,
  company_id text not null,
  company_name text not null check (length(trim(company_name)) between 1 and 240),
  domain text not null check (
    domain = lower(domain)
    and domain !~ '[/:]'
    and length(domain) between 3 and 253
  ),
  status text not null default 'waiting'
    check (status in (
      'waiting',
      'running',
      'review',
      'completed',
      'failed',
      'skipped'
    )),
  progress integer not null default 0 check (progress >= 0),
  page_count integer not null default 0 check (page_count >= 0),
  contacts_found integer not null default 0 check (contacts_found >= 0),
  current_url text check (
    current_url is null
    or current_url ~ '^https://'
  ),
  page_title text,
  current_role text,
  last_error text,
  started_at timestamptz,
  completed_at timestamptz,
  created_by uuid references auth.users(id),
  updated_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (run_id, company_id)
);

create table public.research_events (
  id bigint generated always as identity primary key,
  run_id uuid not null references public.research_runs(id) on delete cascade,
  task_id uuid references public.research_tasks(id) on delete cascade,
  sequence integer not null check (sequence >= 0),
  event_type text not null
    check (event_type in (
      'run',
      'company',
      'robots',
      'page',
      'pdf',
      'candidate',
      'comparison',
      'warning',
      'error'
    )),
  message text not null check (length(trim(message)) between 1 and 1000),
  source_url text check (
    source_url is null
    or source_url ~ '^https://'
  ),
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  unique (run_id, sequence)
);

create table public.research_candidates (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references public.research_runs(id) on delete cascade,
  task_id uuid not null references public.research_tasks(id) on delete cascade,
  external_candidate_id text not null,
  company_id text not null,
  name text not null check (length(trim(name)) between 1 and 240),
  job_title text not null check (length(trim(job_title)) between 1 and 240),
  role_category text not null,
  source_kind text not null,
  source_url text not null check (source_url ~ '^https://'),
  evidence_excerpt text,
  crm_comparison text not null default 'not_checked',
  email_status text not null default 'not_publicly_found',
  confidence numeric(4,3) not null check (confidence between 0 and 1),
  review_status text not null default 'pending'
    check (review_status in ('pending', 'approved', 'rejected', 'investigate')),
  reviewed_by uuid references auth.users(id),
  reviewed_at timestamptz,
  created_by uuid references auth.users(id),
  updated_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (run_id, external_candidate_id),
  check (
    (review_status = 'pending' and reviewed_by is null and reviewed_at is null)
    or
    (review_status <> 'pending' and reviewed_by is not null and reviewed_at is not null)
  )
);

create index research_runs_status_created_idx
  on public.research_runs(status, created_at desc);
create index research_tasks_run_status_idx
  on public.research_tasks(run_id, status, created_at);
create index research_events_run_sequence_idx
  on public.research_events(run_id, sequence);
create index research_events_task_sequence_idx
  on public.research_events(task_id, sequence)
  where task_id is not null;
create index research_candidates_run_review_idx
  on public.research_candidates(run_id, review_status, confidence desc);
create index research_candidates_task_idx
  on public.research_candidates(task_id);
create index research_runs_created_by_idx
  on public.research_runs(created_by);
create index research_runs_updated_by_idx
  on public.research_runs(updated_by);
create index research_tasks_created_by_idx
  on public.research_tasks(created_by);
create index research_tasks_updated_by_idx
  on public.research_tasks(updated_by);
create index research_events_created_by_idx
  on public.research_events(created_by);
create index research_candidates_created_by_idx
  on public.research_candidates(created_by);
create index research_candidates_updated_by_idx
  on public.research_candidates(updated_by);
create index research_candidates_reviewed_by_idx
  on public.research_candidates(reviewed_by)
  where reviewed_by is not null;

alter table public.research_runs enable row level security;
alter table public.research_tasks enable row level security;
alter table public.research_events enable row level security;
alter table public.research_candidates enable row level security;

revoke all on public.research_runs from public, anon, authenticated;
revoke all on public.research_tasks from public, anon, authenticated;
revoke all on public.research_events from public, anon, authenticated;
revoke all on public.research_candidates from public, anon, authenticated;

grant select on public.research_runs to authenticated;
grant select on public.research_tasks to authenticated;
grant select on public.research_events to authenticated;
grant select on public.research_candidates to authenticated;

create policy "GSD employees read research runs"
on public.research_runs for select to authenticated
using (lower(coalesce((select auth.jwt()) ->> 'email', '')) like '%@gsdecorating.com');

create policy "GSD employees read research tasks"
on public.research_tasks for select to authenticated
using (lower(coalesce((select auth.jwt()) ->> 'email', '')) like '%@gsdecorating.com');

create policy "GSD employees read research events"
on public.research_events for select to authenticated
using (lower(coalesce((select auth.jwt()) ->> 'email', '')) like '%@gsdecorating.com');

create policy "GSD employees read research candidates"
on public.research_candidates for select to authenticated
using (lower(coalesce((select auth.jwt()) ->> 'email', '')) like '%@gsdecorating.com');

alter publication supabase_realtime add table public.research_runs;
alter publication supabase_realtime add table public.research_tasks;
alter publication supabase_realtime add table public.research_events;
alter publication supabase_realtime add table public.research_candidates;
