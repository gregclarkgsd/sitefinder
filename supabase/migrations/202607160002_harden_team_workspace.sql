revoke all on public.saved_projects from anon;
revoke all on public.project_notes from anon;

drop policy "GSD team can read saved leads" on public.saved_projects;
drop policy "GSD team can add saved leads" on public.saved_projects;
drop policy "GSD team can update saved leads" on public.saved_projects;
drop policy "GSD team can remove saved leads" on public.saved_projects;
drop policy "GSD team can read notes" on public.project_notes;
drop policy "GSD team can add notes" on public.project_notes;
drop policy "GSD team can update notes" on public.project_notes;
drop policy "GSD team can delete notes" on public.project_notes;

create policy "GSD team can read saved leads" on public.saved_projects for select to authenticated
using (lower(coalesce((select auth.jwt())->>'email','')) like '%@gsdecorating.com');
create policy "GSD team can add saved leads" on public.saved_projects for insert to authenticated
with check (lower(coalesce((select auth.jwt())->>'email','')) like '%@gsdecorating.com' and saved_by = (select auth.uid()));
create policy "GSD team can update saved leads" on public.saved_projects for update to authenticated
using (lower(coalesce((select auth.jwt())->>'email','')) like '%@gsdecorating.com')
with check (lower(coalesce((select auth.jwt())->>'email','')) like '%@gsdecorating.com');
create policy "GSD team can remove saved leads" on public.saved_projects for delete to authenticated
using (lower(coalesce((select auth.jwt())->>'email','')) like '%@gsdecorating.com');

create policy "GSD team can read notes" on public.project_notes for select to authenticated
using (lower(coalesce((select auth.jwt())->>'email','')) like '%@gsdecorating.com');
create policy "GSD team can add notes" on public.project_notes for insert to authenticated
with check (lower(coalesce((select auth.jwt())->>'email','')) like '%@gsdecorating.com' and updated_by = (select auth.uid()));
create policy "GSD team can update notes" on public.project_notes for update to authenticated
using (lower(coalesce((select auth.jwt())->>'email','')) like '%@gsdecorating.com')
with check (lower(coalesce((select auth.jwt())->>'email','')) like '%@gsdecorating.com' and updated_by = (select auth.uid()));
create policy "GSD team can delete notes" on public.project_notes for delete to authenticated
using (lower(coalesce((select auth.jwt())->>'email','')) like '%@gsdecorating.com');
