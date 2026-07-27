alter table public.ccs_projects
  add column if not exists address text,
  add column if not exists site_manager_name text,
  add column if not exists site_manager_job_title text,
  add column if not exists site_manager_phone text,
  add column if not exists marker_email text,
  add column if not exists site_start_date date,
  add column if not exists site_end_date date,
  add column if not exists site_closed boolean,
  add column if not exists summary text,
  add column if not exists last_visit_date date,
  add column if not exists detail_hash text,
  add column if not exists detail_last_checked_at timestamptz,
  add column if not exists detail_error text,
  add column if not exists detail_data jsonb;

alter table public.ccs_sync_runs
  add column if not exists detail_projects integer not null default 0,
  add column if not exists detail_errors integer not null default 0;

create index if not exists ccs_projects_detail_checked_idx
  on public.ccs_projects(detail_last_checked_at)
  where is_active = true;

create index if not exists ccs_projects_end_date_idx
  on public.ccs_projects(site_end_date)
  where is_active = true and site_closed is not true;
