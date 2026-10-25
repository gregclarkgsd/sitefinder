-- Step 2 of 2: every tenant-owned row must belong to a tenant.
-- Run scripts/tenancy/assign-existing-data-to-tenant.sql after step 1 and
-- before this migration. It stops here if any row is still unassigned.

do $$
declare
  t text;
  missing bigint;
  report text := '';
begin
  foreach t in array array[
    'saved_projects', 'project_notes', 'project_tasks', 'lead_tracking',
    'outreach_leads', 'outreach_communications', 'outreach_suppressions',
    'outreach_mailbox_state', 'outreach_oauth_states', 'outreach_reply_outcomes',
    'research_runs', 'research_tasks', 'research_events', 'research_candidates',
    'attio_sync_links'
  ] loop
    execute format('select count(*) from public.%I where tenant_id is null', t) into missing;
    if missing > 0 then
      report := report || format(' %s=%s', t, missing);
    end if;
  end loop;
  if report <> '' then
    raise exception 'rows without a tenant:%', report
      using hint = 'Run scripts/tenancy/assign-existing-data-to-tenant.sql first.';
  end if;

  foreach t in array array[
    'saved_projects', 'project_notes', 'project_tasks', 'lead_tracking',
    'outreach_leads', 'outreach_communications', 'outreach_suppressions',
    'outreach_mailbox_state', 'outreach_oauth_states', 'outreach_reply_outcomes',
    'research_runs', 'research_tasks', 'research_events', 'research_candidates',
    'attio_sync_links'
  ] loop
    execute format('alter table public.%I alter column tenant_id set not null', t);
  end loop;
end;
$$;

-- Per-tenant keys: two tenants can save, note, track or contact the same
-- shared CCS project independently.
alter table public.saved_projects drop constraint saved_projects_pkey;
alter table public.saved_projects add primary key (tenant_id, project_id);

alter table public.project_notes drop constraint project_notes_pkey;
alter table public.project_notes add primary key (tenant_id, project_id);

alter table public.lead_tracking drop constraint lead_tracking_pkey;
alter table public.lead_tracking add primary key (tenant_id, project_id);

drop index public.outreach_leads_project_recipient_key;
create unique index outreach_leads_project_recipient_key
on public.outreach_leads (tenant_id, project_id, lower(recipient_email));

drop index public.outreach_suppressions_email_idx;
create unique index outreach_suppressions_email_idx
on public.outreach_suppressions (tenant_id, email);

-- The composite primary keys lead with tenant_id, so these became redundant.
drop index public.saved_projects_tenant_id_idx;
drop index public.project_notes_tenant_id_idx;
drop index public.lead_tracking_tenant_id_idx;
