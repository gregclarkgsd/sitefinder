create index if not exists lead_tracking_assigned_to_idx on public.lead_tracking(assigned_to);
create index if not exists lead_tracking_updated_by_idx on public.lead_tracking(updated_by);
create index if not exists project_tasks_created_by_idx on public.project_tasks(created_by);
create index if not exists project_tasks_updated_by_idx on public.project_tasks(updated_by);
create index if not exists saved_projects_saved_by_idx on public.saved_projects(saved_by);
create index if not exists project_notes_updated_by_idx on public.project_notes(updated_by);

drop policy if exists "GSD employees read CCS history" on public.ccs_projects;
create policy "GSD employees read CCS history"
on public.ccs_projects for select to authenticated
using (lower(coalesce((select auth.jwt()) ->> 'email','')) like '%@gsdecorating.com');

drop policy if exists "GSD employees read sync history" on public.ccs_sync_runs;
create policy "GSD employees read sync history"
on public.ccs_sync_runs for select to authenticated
using (lower(coalesce((select auth.jwt()) ->> 'email','')) like '%@gsdecorating.com');

drop policy if exists "GSD employees read lead tracking" on public.lead_tracking;
create policy "GSD employees read lead tracking"
on public.lead_tracking for select to authenticated
using (lower(coalesce((select auth.jwt()) ->> 'email','')) like '%@gsdecorating.com');

drop policy if exists "GSD employees add lead tracking" on public.lead_tracking;
create policy "GSD employees add lead tracking"
on public.lead_tracking for insert to authenticated
with check (
  lower(coalesce((select auth.jwt()) ->> 'email','')) like '%@gsdecorating.com'
  and updated_by = (select auth.uid())
);

drop policy if exists "GSD employees update lead tracking" on public.lead_tracking;
create policy "GSD employees update lead tracking"
on public.lead_tracking for update to authenticated
using (lower(coalesce((select auth.jwt()) ->> 'email','')) like '%@gsdecorating.com')
with check (
  lower(coalesce((select auth.jwt()) ->> 'email','')) like '%@gsdecorating.com'
  and updated_by = (select auth.uid())
);

drop policy if exists "GSD employees delete lead tracking" on public.lead_tracking;
create policy "GSD employees delete lead tracking"
on public.lead_tracking for delete to authenticated
using (lower(coalesce((select auth.jwt()) ->> 'email','')) like '%@gsdecorating.com');

drop policy if exists "GSD employees read project tasks" on public.project_tasks;
create policy "GSD employees read project tasks"
on public.project_tasks for select to authenticated
using (lower(coalesce((select auth.jwt()) ->> 'email','')) like '%@gsdecorating.com');

drop policy if exists "GSD employees create project tasks" on public.project_tasks;
create policy "GSD employees create project tasks"
on public.project_tasks for insert to authenticated
with check (
  lower(coalesce((select auth.jwt()) ->> 'email','')) like '%@gsdecorating.com'
  and created_by = (select auth.uid())
  and updated_by = (select auth.uid())
);

drop policy if exists "GSD employees update project tasks" on public.project_tasks;
create policy "GSD employees update project tasks"
on public.project_tasks for update to authenticated
using (lower(coalesce((select auth.jwt()) ->> 'email','')) like '%@gsdecorating.com')
with check (
  lower(coalesce((select auth.jwt()) ->> 'email','')) like '%@gsdecorating.com'
  and updated_by = (select auth.uid())
);

drop policy if exists "GSD employees delete project tasks" on public.project_tasks;
create policy "GSD employees delete project tasks"
on public.project_tasks for delete to authenticated
using (lower(coalesce((select auth.jwt()) ->> 'email','')) like '%@gsdecorating.com');
