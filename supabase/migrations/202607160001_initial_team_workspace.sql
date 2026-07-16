create table public.saved_projects (
  project_id text primary key,
  project_name text not null,
  saved_by uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);
create table public.project_notes (
  project_id text primary key,
  project_name text not null,
  note text not null check (char_length(note) <= 5000),
  updated_by uuid not null references auth.users(id) on delete cascade,
  updated_at timestamptz not null default now()
);
alter table public.saved_projects enable row level security;
alter table public.project_notes enable row level security;
grant select, insert, update, delete on public.saved_projects to authenticated;
grant select, insert, update, delete on public.project_notes to authenticated;

create policy "GSD team can read saved leads" on public.saved_projects for select to authenticated
using (lower(coalesce(auth.jwt()->>'email','')) like '%@gsdecorating.com');
create policy "GSD team can add saved leads" on public.saved_projects for insert to authenticated
with check (lower(coalesce(auth.jwt()->>'email','')) like '%@gsdecorating.com' and saved_by = (select auth.uid()));
create policy "GSD team can update saved leads" on public.saved_projects for update to authenticated
using (lower(coalesce(auth.jwt()->>'email','')) like '%@gsdecorating.com')
with check (lower(coalesce(auth.jwt()->>'email','')) like '%@gsdecorating.com');
create policy "GSD team can remove saved leads" on public.saved_projects for delete to authenticated
using (lower(coalesce(auth.jwt()->>'email','')) like '%@gsdecorating.com');

create policy "GSD team can read notes" on public.project_notes for select to authenticated
using (lower(coalesce(auth.jwt()->>'email','')) like '%@gsdecorating.com');
create policy "GSD team can add notes" on public.project_notes for insert to authenticated
with check (lower(coalesce(auth.jwt()->>'email','')) like '%@gsdecorating.com' and updated_by = (select auth.uid()));
create policy "GSD team can update notes" on public.project_notes for update to authenticated
using (lower(coalesce(auth.jwt()->>'email','')) like '%@gsdecorating.com')
with check (lower(coalesce(auth.jwt()->>'email','')) like '%@gsdecorating.com' and updated_by = (select auth.uid()));
create policy "GSD team can delete notes" on public.project_notes for delete to authenticated
using (lower(coalesce(auth.jwt()->>'email','')) like '%@gsdecorating.com');

create index saved_projects_created_at_idx on public.saved_projects(created_at desc);
create index project_notes_updated_at_idx on public.project_notes(updated_at desc);
