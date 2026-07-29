-- Outreach history and do-not-contact records are compliance evidence. They must
-- survive employee account removal and source-project cleanup.

alter table public.outreach_communications
  alter column created_by drop not null,
  alter column project_id drop not null;

alter table public.outreach_suppressions
  alter column created_by drop not null;

alter table public.outreach_communications
  drop constraint if exists outreach_communications_created_by_fkey,
  add constraint outreach_communications_created_by_fkey
    foreign key (created_by) references auth.users(id) on delete set null,
  drop constraint if exists outreach_communications_project_id_fkey,
  add constraint outreach_communications_project_id_fkey
    foreign key (project_id) references public.ccs_projects(project_id) on delete set null;

alter table public.outreach_suppressions
  drop constraint if exists outreach_suppressions_created_by_fkey,
  add constraint outreach_suppressions_created_by_fkey
    foreign key (created_by) references auth.users(id) on delete set null;

alter table public.outreach_leads
  drop constraint if exists outreach_leads_project_id_fkey,
  add constraint outreach_leads_project_id_fkey
    foreign key (project_id) references public.ccs_projects(project_id) on delete restrict;

-- Ordinary users may add a suppression but cannot erase or weaken one. Removal
-- requires a deliberate privileged administrative operation.
revoke update, delete on public.outreach_suppressions from authenticated;

drop policy if exists "GSD employees update outreach suppressions"
  on public.outreach_suppressions;
drop policy if exists "GSD employees delete outreach suppressions"
  on public.outreach_suppressions;

comment on table public.outreach_suppressions is
  'Durable do-not-contact register. Entries survive user deletion and are removable only by a privileged administrator.';

comment on table public.outreach_communications is
  'Durable outreach audit history. Actor and project references may become null without deleting the communication.';
