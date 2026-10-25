-- Operational script: assign every row that predates tenancy to one tenant.
-- Run once, by hand, after migration 20261025100000 and before 20261025100100:
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 \
--     -v tenant_slug='example' \
--     -f scripts/tenancy/assign-existing-data-to-tenant.sql
--
-- Only rows whose tenant_id is still null are touched, so it is safe to re-run.
-- It prints how many rows each table received and how many remain unassigned.

\set ON_ERROR_STOP 1

select exists (select 1 from public.tenants where slug = :'tenant_slug') as tenant_found \gset

\if :tenant_found
\else
  do $$ begin raise exception 'No tenant with that slug.'; end $$;
\endif

begin;

select set_config('tenancy.slug', :'tenant_slug', true) as tenant_slug;

create temporary table tenancy_backfill_report (table_name text, assigned bigint) on commit drop;

do $$
declare
  target uuid := (select id from public.tenants where slug = current_setting('tenancy.slug'));
  t text;
  assigned bigint;
begin
  foreach t in array array[
    'saved_projects', 'project_notes', 'project_tasks', 'lead_tracking',
    'outreach_leads', 'outreach_communications', 'outreach_suppressions',
    'outreach_mailbox_state', 'outreach_oauth_states', 'outreach_reply_outcomes',
    'research_runs', 'research_tasks', 'research_events', 'research_candidates',
    'attio_sync_links'
  ] loop
    execute format('update public.%I set tenant_id = $1 where tenant_id is null', t) using target;
    get diagnostics assigned = row_count;
    insert into tenancy_backfill_report values (t, assigned);
  end loop;
end;
$$;

select r.table_name, r.assigned
from tenancy_backfill_report r
order by r.table_name;

commit;
