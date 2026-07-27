create table if not exists public.ccs_project_schedule (
  project_id text primary key,
  site_start_date date,
  site_end_date date,
  site_closed boolean,
  is_active boolean not null default true,
  updated_at timestamptz not null default now()
);

alter table public.ccs_project_schedule enable row level security;

revoke all on table public.ccs_project_schedule from public;
grant select on table public.ccs_project_schedule to anon, authenticated;

drop policy if exists "Public CCS schedule is readable" on public.ccs_project_schedule;
create policy "Public CCS schedule is readable"
on public.ccs_project_schedule
for select
to anon, authenticated
using (true);

create index if not exists ccs_project_schedule_active_end_date_idx
  on public.ccs_project_schedule (is_active, site_end_date);
