create index if not exists outreach_leads_approved_by_idx on public.outreach_leads(approved_by);
create index if not exists outreach_leads_created_by_idx on public.outreach_leads(created_by);
create index if not exists outreach_leads_updated_by_idx on public.outreach_leads(updated_by);
create index if not exists outreach_communications_lead_idx on public.outreach_communications(outreach_lead_id);
create index if not exists outreach_communications_created_by_idx on public.outreach_communications(created_by);
create index if not exists outreach_suppressions_created_by_idx on public.outreach_suppressions(created_by);

drop policy if exists "GSD employees read outreach leads" on public.outreach_leads;
create policy "GSD employees read outreach leads"
on public.outreach_leads for select to authenticated
using (lower(coalesce((select auth.jwt()) ->> 'email','')) like '%@gsdecorating.com');

drop policy if exists "GSD employees create outreach leads" on public.outreach_leads;
create policy "GSD employees create outreach leads"
on public.outreach_leads for insert to authenticated
with check (
  lower(coalesce((select auth.jwt()) ->> 'email','')) like '%@gsdecorating.com'
  and created_by = (select auth.uid())
);

drop policy if exists "GSD employees update outreach leads" on public.outreach_leads;
create policy "GSD employees update outreach leads"
on public.outreach_leads for update to authenticated
using (lower(coalesce((select auth.jwt()) ->> 'email','')) like '%@gsdecorating.com')
with check (
  lower(coalesce((select auth.jwt()) ->> 'email','')) like '%@gsdecorating.com'
  and updated_by = (select auth.uid())
);

drop policy if exists "GSD employees delete outreach leads" on public.outreach_leads;
create policy "GSD employees delete outreach leads"
on public.outreach_leads for delete to authenticated
using (lower(coalesce((select auth.jwt()) ->> 'email','')) like '%@gsdecorating.com');

drop policy if exists "GSD employees read outreach communications" on public.outreach_communications;
create policy "GSD employees read outreach communications"
on public.outreach_communications for select to authenticated
using (lower(coalesce((select auth.jwt()) ->> 'email','')) like '%@gsdecorating.com');

drop policy if exists "GSD employees log outreach communications" on public.outreach_communications;
create policy "GSD employees log outreach communications"
on public.outreach_communications for insert to authenticated
with check (
  lower(coalesce((select auth.jwt()) ->> 'email','')) like '%@gsdecorating.com'
  and created_by = (select auth.uid())
);

drop policy if exists "GSD employees read outreach suppressions" on public.outreach_suppressions;
create policy "GSD employees read outreach suppressions"
on public.outreach_suppressions for select to authenticated
using (lower(coalesce((select auth.jwt()) ->> 'email','')) like '%@gsdecorating.com');

drop policy if exists "GSD employees create outreach suppressions" on public.outreach_suppressions;
create policy "GSD employees create outreach suppressions"
on public.outreach_suppressions for insert to authenticated
with check (
  lower(coalesce((select auth.jwt()) ->> 'email','')) like '%@gsdecorating.com'
  and created_by = (select auth.uid())
);

drop policy if exists "GSD employees update outreach suppressions" on public.outreach_suppressions;
create policy "GSD employees update outreach suppressions"
on public.outreach_suppressions for update to authenticated
using (lower(coalesce((select auth.jwt()) ->> 'email','')) like '%@gsdecorating.com')
with check (
  lower(coalesce((select auth.jwt()) ->> 'email','')) like '%@gsdecorating.com'
  and created_by = (select auth.uid())
);

drop policy if exists "GSD employees delete outreach suppressions" on public.outreach_suppressions;
create policy "GSD employees delete outreach suppressions"
on public.outreach_suppressions for delete to authenticated
using (lower(coalesce((select auth.jwt()) ->> 'email','')) like '%@gsdecorating.com');
