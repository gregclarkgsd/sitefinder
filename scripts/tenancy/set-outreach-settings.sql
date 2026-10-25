-- Operational script: set a tenant's outreach automation settings.
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 \
--     -v tenant_slug='example' \
--     -v auto_queue=true \
--     -v subject_template='Is {{project_name}} still live?' \
--     -v body_template="$(cat path/to/body-template.txt)" \
--     -v attio_project_sync=false \
--     -f scripts/tenancy/set-outreach-settings.sql
--
-- auto_queue: queue an outreach draft for each newly discovered CCS project,
--   rendered from the templates. {{project_name}} and {{first_name}} are
--   replaced; {{first_name}} falls back to "there".
-- attio_project_sync: this tenant owns links written by sync-ccs-projects-to-attio.
--   Only one tenant can hold it.
--
-- The scheduled outreach functions are not tenant-aware yet: do not turn
-- auto_queue on for more than one tenant until they are.

\set ON_ERROR_STOP 1

select exists (select 1 from public.tenants where slug = :'tenant_slug') as tenant_found \gset

\if :tenant_found
\else
  do $$ begin raise exception 'No tenant with that slug.'; end $$;
\endif

insert into public.tenant_outreach_settings (
  tenant_id,
  auto_queue_new_ccs_projects,
  auto_queue_subject_template,
  auto_queue_body_template,
  attio_project_sync_enabled,
  updated_at
)
select
  t.id,
  :'auto_queue'::boolean,
  nullif(:'subject_template', ''),
  nullif(:'body_template', ''),
  :'attio_project_sync'::boolean,
  now()
from public.tenants t
where t.slug = :'tenant_slug'
on conflict (tenant_id) do update set
  auto_queue_new_ccs_projects = excluded.auto_queue_new_ccs_projects,
  auto_queue_subject_template = excluded.auto_queue_subject_template,
  auto_queue_body_template = excluded.auto_queue_body_template,
  attio_project_sync_enabled = excluded.attio_project_sync_enabled,
  updated_at = excluded.updated_at
returning tenant_id, auto_queue_new_ccs_projects, attio_project_sync_enabled;
