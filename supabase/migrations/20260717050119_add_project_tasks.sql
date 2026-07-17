create table if not exists public.project_tasks (
  id uuid primary key default gen_random_uuid(),
  project_id text not null,
  project_name text not null,
  title text not null check (char_length(title) between 1 and 240),
  details text,
  assigned_email text,
  due_date date,
  completed boolean not null default false,
  completed_at timestamptz,
  created_by uuid not null references auth.users(id) on delete cascade,
  updated_by uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists project_tasks_project_idx on public.project_tasks(project_id, completed, due_date);
create index if not exists project_tasks_due_idx on public.project_tasks(completed, due_date) where completed = false;

alter table public.project_tasks enable row level security;
revoke all on public.project_tasks from anon;
grant select, insert, update, delete on public.project_tasks to authenticated;

create policy "GSD employees read project tasks"
on public.project_tasks for select to authenticated
using (lower(coalesce(auth.jwt() ->> 'email','')) like '%@gsdecorating.com');

create policy "GSD employees create project tasks"
on public.project_tasks for insert to authenticated
with check (
  lower(coalesce(auth.jwt() ->> 'email','')) like '%@gsdecorating.com'
  and created_by = (select auth.uid())
  and updated_by = (select auth.uid())
);

create policy "GSD employees update project tasks"
on public.project_tasks for update to authenticated
using (lower(coalesce(auth.jwt() ->> 'email','')) like '%@gsdecorating.com')
with check (
  lower(coalesce(auth.jwt() ->> 'email','')) like '%@gsdecorating.com'
  and updated_by = (select auth.uid())
);

create policy "GSD employees delete project tasks"
on public.project_tasks for delete to authenticated
using (lower(coalesce(auth.jwt() ->> 'email','')) like '%@gsdecorating.com');
