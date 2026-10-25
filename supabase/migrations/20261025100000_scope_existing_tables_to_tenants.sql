-- Step 1 of 2 for moving the existing Site Finder tables onto tenants.
--
-- Adds a nullable tenant_id to every tenant-owned table, derives it on insert
-- from the parent row or the acting user, and replaces the email-domain
-- policies with membership policies. Existing rows are assigned to a tenant
-- by scripts/tenancy/assign-existing-data-to-tenant.sql, then step 2
-- (20261025100100) makes tenant_id NOT NULL and moves keys to per-tenant.
-- Rows with a null tenant_id are invisible to app users between the steps.
--
-- ccs_* tables stay shared public data, readable by anyone in any tenant.
-- outreach_programme_snapshot is a frozen audit record that the app does not
-- read; it loses its email-domain policy and becomes service-role only.

-- Helpers ------------------------------------------------------------------

create function public.has_tenant_membership()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.tenant_members where user_id = (select auth.uid())
  );
$$;

revoke all on function public.has_tenant_membership() from public, anon;
grant execute on function public.has_tenant_membership() to authenticated, service_role;

-- The only tenant a user belongs to, or null when they have none or several.
create function private.sole_tenant_for_user(u uuid)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select case when count(*) = 1 then (array_agg(tenant_id))[1] end
  from public.tenant_members
  where user_id = u;
$$;

revoke all on function private.sole_tenant_for_user(uuid) from public, anon, authenticated;

-- Per-tenant outreach settings ----------------------------------------------
-- Written operationally only (scripts/tenancy/set-outreach-settings.sql):
-- the scheduled outreach functions are not tenant-aware yet, so app users
-- must not be able to switch auto-queueing or the Attio project sync on.

create table public.tenant_outreach_settings (
  tenant_id uuid primary key references public.tenants(id) on delete cascade,
  auto_queue_new_ccs_projects boolean not null default false,
  auto_queue_subject_template text,
  auto_queue_body_template text,
  attio_project_sync_enabled boolean not null default false,
  updated_at timestamptz not null default now(),
  constraint tenant_outreach_settings_templates_present check (
    not auto_queue_new_ccs_projects
    or (
      length(btrim(coalesce(auto_queue_subject_template, ''))) > 0
      and length(btrim(coalesce(auto_queue_body_template, ''))) > 0
    )
  )
);

-- sync-ccs-projects-to-attio writes to a single Attio workspace, so at most
-- one tenant can own the project sync until that function is tenant-aware.
create unique index tenant_outreach_settings_single_attio_sync_idx
on public.tenant_outreach_settings (attio_project_sync_enabled)
where attio_project_sync_enabled;

alter table public.tenant_outreach_settings enable row level security;
revoke all on public.tenant_outreach_settings from public, anon, authenticated;
grant select on public.tenant_outreach_settings to authenticated;
grant all on public.tenant_outreach_settings to service_role;

create policy "Tenant members read outreach settings"
on public.tenant_outreach_settings for select to authenticated
using (public.is_tenant_member(tenant_id));

-- tenant_id columns -----------------------------------------------------------

do $$
declare
  t text;
begin
  foreach t in array array[
    'saved_projects', 'project_notes', 'project_tasks', 'lead_tracking',
    'outreach_leads', 'outreach_communications', 'outreach_suppressions',
    'outreach_mailbox_state', 'outreach_oauth_states', 'outreach_reply_outcomes',
    'research_runs', 'research_tasks', 'research_events', 'research_candidates',
    'attio_sync_links'
  ] loop
    execute format(
      'alter table public.%I add column tenant_id uuid references public.tenants(id) on delete restrict',
      t
    );
    execute format('create index %I on public.%I (tenant_id)', t || '_tenant_id_idx', t);
  end loop;
end;
$$;

-- tenant_id derivation --------------------------------------------------------
-- Writers that predate tenancy (including deployed Edge Functions) do not
-- send tenant_id, so it is derived before insert. Nothing here falls back to
-- a default tenant: when no single tenant can be determined, tenant_id stays
-- null and the NOT NULL constraint from step 2 rejects the row.

-- tg_argv[0]: the column holding the acting user.
create function private.derive_tenant_from_actor()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.tenant_id is null then
    new.tenant_id := private.sole_tenant_for_user(
      nullif(to_jsonb(new) ->> tg_argv[0], '')::uuid
    );
  end if;
  return new;
end;
$$;

-- tg_argv[0]: parent table, tg_argv[1]: column referencing parent.id,
-- tg_argv[2] (optional): acting-user column used when there is no parent.
-- A child always lives in its parent's tenant.
create function private.derive_tenant_from_parent()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  parent_id uuid := nullif(to_jsonb(new) ->> tg_argv[1], '')::uuid;
  parent_tenant uuid;
begin
  if parent_id is not null then
    execute format('select tenant_id from public.%I where id = $1', tg_argv[0])
      into parent_tenant
      using parent_id;
  end if;

  if parent_tenant is not null then
    if new.tenant_id is not null and new.tenant_id <> parent_tenant then
      raise exception '% row belongs to a different tenant than its %', tg_table_name, tg_argv[0]
        using errcode = '23514';
    end if;
    new.tenant_id := parent_tenant;
  elsif new.tenant_id is null and tg_nargs > 2 then
    new.tenant_id := private.sole_tenant_for_user(
      nullif(to_jsonb(new) ->> tg_argv[2], '')::uuid
    );
  end if;
  return new;
end;
$$;

-- Research runs are also upserted by the worker for runs that already exist.
create function private.derive_research_run_tenant()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.tenant_id is null then
    select r.tenant_id into new.tenant_id from public.research_runs r where r.id = new.id;
  end if;
  if new.tenant_id is null then
    new.tenant_id := private.sole_tenant_for_user(new.created_by);
  end if;
  return new;
end;
$$;

-- Suppressions come from replies to a lead, so they follow that lead's
-- tenant; otherwise the acting user's tenant.
create function private.derive_suppression_tenant()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.tenant_id is null then
    select case when count(distinct l.tenant_id) = 1 then (array_agg(l.tenant_id))[1] end
    into new.tenant_id
    from public.outreach_leads l
    where lower(l.recipient_email) = lower(new.email)
      and l.tenant_id is not null;
  end if;
  if new.tenant_id is null then
    new.tenant_id := private.sole_tenant_for_user(new.created_by);
  end if;
  return new;
end;
$$;

create function private.derive_mailbox_tenant()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.tenant_id is null then
    select m.tenant_id into new.tenant_id
    from public.outreach_mailbox_state m
    where m.mailbox_email = new.mailbox_email;
  end if;
  if new.tenant_id is null then
    new.tenant_id := private.sole_tenant_for_user(new.connected_by);
  end if;
  return new;
end;
$$;

create function private.derive_attio_link_tenant()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.tenant_id is null then
    select l.tenant_id into new.tenant_id
    from public.attio_sync_links l
    where l.entity_type = new.entity_type and l.source_key = new.source_key;
  end if;
  if new.tenant_id is null then
    select s.tenant_id into new.tenant_id
    from public.tenant_outreach_settings s
    where s.attio_project_sync_enabled;
  end if;
  return new;
end;
$$;

create function private.prevent_tenant_change()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.tenant_id is not null and new.tenant_id is distinct from old.tenant_id then
    raise exception 'tenant_id cannot be changed on %', tg_table_name
      using errcode = '23514';
  end if;
  return new;
end;
$$;

revoke all on function
  private.derive_tenant_from_actor(),
  private.derive_tenant_from_parent(),
  private.derive_research_run_tenant(),
  private.derive_suppression_tenant(),
  private.derive_mailbox_tenant(),
  private.derive_attio_link_tenant(),
  private.prevent_tenant_change()
from public, anon, authenticated;

create trigger set_tenant_id before insert on public.saved_projects
for each row execute function private.derive_tenant_from_actor('saved_by');
create trigger set_tenant_id before insert on public.project_notes
for each row execute function private.derive_tenant_from_actor('updated_by');
create trigger set_tenant_id before insert on public.project_tasks
for each row execute function private.derive_tenant_from_actor('created_by');
create trigger set_tenant_id before insert on public.lead_tracking
for each row execute function private.derive_tenant_from_actor('updated_by');
create trigger set_tenant_id before insert on public.outreach_leads
for each row execute function private.derive_tenant_from_actor('created_by');
create trigger set_tenant_id before insert on public.outreach_communications
for each row execute function private.derive_tenant_from_parent('outreach_leads', 'outreach_lead_id', 'created_by');
create trigger set_tenant_id before insert on public.outreach_reply_outcomes
for each row execute function private.derive_tenant_from_parent('outreach_leads', 'outreach_lead_id');
create trigger set_tenant_id before insert on public.outreach_suppressions
for each row execute function private.derive_suppression_tenant();
create trigger set_tenant_id before insert on public.outreach_mailbox_state
for each row execute function private.derive_mailbox_tenant();
create trigger set_tenant_id before insert on public.outreach_oauth_states
for each row execute function private.derive_tenant_from_actor('requested_by');
create trigger set_tenant_id before insert on public.research_runs
for each row execute function private.derive_research_run_tenant();
create trigger set_tenant_id before insert on public.research_tasks
for each row execute function private.derive_tenant_from_parent('research_runs', 'run_id');
create trigger set_tenant_id before insert on public.research_events
for each row execute function private.derive_tenant_from_parent('research_runs', 'run_id');
create trigger set_tenant_id before insert on public.research_candidates
for each row execute function private.derive_tenant_from_parent('research_runs', 'run_id');
create trigger set_tenant_id before insert on public.attio_sync_links
for each row execute function private.derive_attio_link_tenant();

do $$
declare
  t text;
begin
  foreach t in array array[
    'saved_projects', 'project_notes', 'project_tasks', 'lead_tracking',
    'outreach_leads', 'outreach_communications', 'outreach_suppressions',
    'outreach_mailbox_state', 'outreach_oauth_states', 'outreach_reply_outcomes',
    'research_runs', 'research_tasks', 'research_events', 'research_candidates',
    'attio_sync_links'
  ] loop
    execute format(
      'create trigger keep_tenant_id before update of tenant_id on public.%I '
      'for each row execute function private.prevent_tenant_change()',
      t
    );
  end loop;
end;
$$;

-- CCS auto-queue ----------------------------------------------------------------
-- New CCS projects are queued once per tenant that has opted in, using that
-- tenant's own templates. {{project_name}} and {{first_name}} are replaced.

create function private.render_outreach_template(
  template text,
  project_name text,
  first_name text
)
returns text
language sql
immutable
set search_path = ''
as $$
  select replace(
    replace(template, '{{project_name}}', coalesce(project_name, '')),
    '{{first_name}}',
    coalesce(nullif(first_name, ''), 'there')
  );
$$;

revoke all on function private.render_outreach_template(text, text, text) from public, anon, authenticated;

create or replace function private.queue_new_ccs_project_for_outreach()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  contact_first_name text;
begin
  if not new.discovered_after_baseline then
    return new;
  end if;

  contact_first_name := nullif(split_part(coalesce(new.site_manager_name, ''), ' ', 1), '');

  insert into public.outreach_leads (
    tenant_id,
    project_id,
    project_name,
    recipient_email,
    recipient_name,
    company_name,
    status,
    email_subject,
    email_body
  )
  select
    s.tenant_id,
    new.project_id,
    new.project_name,
    new.marker_email,
    new.site_manager_name,
    coalesce(new.main_contractor, new.client),
    'queued',
    private.render_outreach_template(s.auto_queue_subject_template, new.project_name, contact_first_name),
    private.render_outreach_template(s.auto_queue_body_template, new.project_name, contact_first_name)
  from public.tenant_outreach_settings s
  where s.auto_queue_new_ccs_projects
    and not exists (
      select 1 from public.outreach_leads ol
      where ol.project_id = new.project_id and ol.tenant_id = s.tenant_id
    )
  on conflict do nothing;

  return new;
end;
$$;

-- Policies ----------------------------------------------------------------------

drop policy "GSD employees read Attio links" on public.attio_sync_links;
drop policy "GSD employees read CCS enrichment" on public.ccs_project_enrichment;
drop policy "GSD employees read CCS history" on public.ccs_projects;
drop policy "GSD employees read sync history" on public.ccs_sync_runs;
drop policy "GSD employees add lead tracking" on public.lead_tracking;
drop policy "GSD employees delete lead tracking" on public.lead_tracking;
drop policy "GSD employees read lead tracking" on public.lead_tracking;
drop policy "GSD employees update lead tracking" on public.lead_tracking;
drop policy "GSD employees log outreach communications" on public.outreach_communications;
drop policy "GSD employees read outreach communications" on public.outreach_communications;
drop policy "GSD employees create outreach leads" on public.outreach_leads;
drop policy "GSD employees delete outreach leads" on public.outreach_leads;
drop policy "GSD employees read outreach leads" on public.outreach_leads;
drop policy "GSD employees update outreach leads" on public.outreach_leads;
drop policy "GSD employees read outreach programme snapshot" on public.outreach_programme_snapshot;
drop policy "GSD employees read outreach reply outcomes" on public.outreach_reply_outcomes;
drop policy "GSD employees create outreach suppressions" on public.outreach_suppressions;
drop policy "GSD employees read outreach suppressions" on public.outreach_suppressions;
drop policy "GSD team can add notes" on public.project_notes;
drop policy "GSD team can delete notes" on public.project_notes;
drop policy "GSD team can read notes" on public.project_notes;
drop policy "GSD team can update notes" on public.project_notes;
drop policy "GSD employees create project tasks" on public.project_tasks;
drop policy "GSD employees delete project tasks" on public.project_tasks;
drop policy "GSD employees read project tasks" on public.project_tasks;
drop policy "GSD employees update project tasks" on public.project_tasks;
drop policy "GSD employees read research candidates" on public.research_candidates;
drop policy "GSD employees read research events" on public.research_events;
drop policy "GSD employees read research runs" on public.research_runs;
drop policy "GSD employees read research tasks" on public.research_tasks;
drop policy "GSD team can add saved leads" on public.saved_projects;
drop policy "GSD team can read saved leads" on public.saved_projects;
drop policy "GSD team can remove saved leads" on public.saved_projects;
drop policy "GSD team can update saved leads" on public.saved_projects;

-- Shared CCS data: any signed-in tenant member.
create policy "Tenant members read CCS history"
on public.ccs_projects for select to authenticated
using (public.has_tenant_membership());
create policy "Tenant members read CCS enrichment"
on public.ccs_project_enrichment for select to authenticated
using (public.has_tenant_membership());
create policy "Tenant members read sync history"
on public.ccs_sync_runs for select to authenticated
using (public.has_tenant_membership());

-- Read-only tenant data.
create policy "Tenant members read Attio links"
on public.attio_sync_links for select to authenticated
using (public.is_tenant_member(tenant_id));
create policy "Tenant members read outreach reply outcomes"
on public.outreach_reply_outcomes for select to authenticated
using (public.is_tenant_member(tenant_id));
create policy "Tenant members read research runs"
on public.research_runs for select to authenticated
using (public.is_tenant_member(tenant_id));
create policy "Tenant members read research tasks"
on public.research_tasks for select to authenticated
using (public.is_tenant_member(tenant_id));
create policy "Tenant members read research events"
on public.research_events for select to authenticated
using (public.is_tenant_member(tenant_id));
create policy "Tenant members read research candidates"
on public.research_candidates for select to authenticated
using (public.is_tenant_member(tenant_id));

-- Saved projects.
create policy "Tenant members read saved projects"
on public.saved_projects for select to authenticated
using (public.is_tenant_member(tenant_id));
create policy "Tenant members save projects"
on public.saved_projects for insert to authenticated
with check (public.is_tenant_member(tenant_id, 'member') and saved_by = (select auth.uid()));
create policy "Tenant members update saved projects"
on public.saved_projects for update to authenticated
using (public.is_tenant_member(tenant_id, 'member'))
with check (public.is_tenant_member(tenant_id, 'member'));
create policy "Tenant members remove saved projects"
on public.saved_projects for delete to authenticated
using (public.is_tenant_member(tenant_id, 'member'));

-- Project notes.
create policy "Tenant members read notes"
on public.project_notes for select to authenticated
using (public.is_tenant_member(tenant_id));
create policy "Tenant members add notes"
on public.project_notes for insert to authenticated
with check (public.is_tenant_member(tenant_id, 'member') and updated_by = (select auth.uid()));
create policy "Tenant members update notes"
on public.project_notes for update to authenticated
using (public.is_tenant_member(tenant_id, 'member'))
with check (public.is_tenant_member(tenant_id, 'member') and updated_by = (select auth.uid()));
create policy "Tenant members delete notes"
on public.project_notes for delete to authenticated
using (public.is_tenant_member(tenant_id, 'member'));

-- Project tasks.
create policy "Tenant members read project tasks"
on public.project_tasks for select to authenticated
using (public.is_tenant_member(tenant_id));
create policy "Tenant members create project tasks"
on public.project_tasks for insert to authenticated
with check (
  public.is_tenant_member(tenant_id, 'member')
  and created_by = (select auth.uid())
  and updated_by = (select auth.uid())
);
create policy "Tenant members update project tasks"
on public.project_tasks for update to authenticated
using (public.is_tenant_member(tenant_id, 'member'))
with check (public.is_tenant_member(tenant_id, 'member') and updated_by = (select auth.uid()));
create policy "Tenant members delete project tasks"
on public.project_tasks for delete to authenticated
using (public.is_tenant_member(tenant_id, 'member'));

-- Lead tracking.
create policy "Tenant members read lead tracking"
on public.lead_tracking for select to authenticated
using (public.is_tenant_member(tenant_id));
create policy "Tenant members add lead tracking"
on public.lead_tracking for insert to authenticated
with check (public.is_tenant_member(tenant_id, 'member') and updated_by = (select auth.uid()));
create policy "Tenant members update lead tracking"
on public.lead_tracking for update to authenticated
using (public.is_tenant_member(tenant_id, 'member'))
with check (public.is_tenant_member(tenant_id, 'member') and updated_by = (select auth.uid()));
create policy "Tenant members delete lead tracking"
on public.lead_tracking for delete to authenticated
using (public.is_tenant_member(tenant_id, 'member'));

-- Outreach leads.
create policy "Tenant members read outreach leads"
on public.outreach_leads for select to authenticated
using (public.is_tenant_member(tenant_id));
create policy "Tenant members create outreach leads"
on public.outreach_leads for insert to authenticated
with check (public.is_tenant_member(tenant_id, 'member') and created_by = (select auth.uid()));
create policy "Tenant members update outreach leads"
on public.outreach_leads for update to authenticated
using (public.is_tenant_member(tenant_id, 'member'))
with check (public.is_tenant_member(tenant_id, 'member') and updated_by = (select auth.uid()));
create policy "Tenant members delete outreach leads"
on public.outreach_leads for delete to authenticated
using (public.is_tenant_member(tenant_id, 'member'));

-- Outreach communications.
create policy "Tenant members read outreach communications"
on public.outreach_communications for select to authenticated
using (public.is_tenant_member(tenant_id));
create policy "Tenant members log outreach communications"
on public.outreach_communications for insert to authenticated
with check (public.is_tenant_member(tenant_id, 'member') and created_by = (select auth.uid()));

-- Outreach suppressions.
create policy "Tenant members read outreach suppressions"
on public.outreach_suppressions for select to authenticated
using (public.is_tenant_member(tenant_id));
create policy "Tenant members create outreach suppressions"
on public.outreach_suppressions for insert to authenticated
with check (public.is_tenant_member(tenant_id, 'member') and created_by = (select auth.uid()));
