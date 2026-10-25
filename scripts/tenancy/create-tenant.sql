-- Operational script: create a tenant and its first admin.
-- Run by hand with a service-level connection, never from a migration:
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 \
--     -v tenant_name='Example Ltd' \
--     -v tenant_slug='example' \
--     -v admin_email='admin@example.com' \
--     -f scripts/tenancy/create-tenant.sql
--
-- The admin must already have signed in once so an auth.users row exists.
-- Re-running with the same slug is safe: the tenant is reused and the
-- admin's role is raised to admin. The tenant id is printed at the end.

\set ON_ERROR_STOP 1

select exists (
  select 1 from auth.users where lower(email) = lower(:'admin_email')
) as admin_found \gset

\if :admin_found
\else
  do $$ begin raise exception 'No auth user with that email. Ask them to sign in once, then re-run.'; end $$;
\endif

begin;

insert into public.tenants (name, slug)
values (:'tenant_name', :'tenant_slug')
on conflict (slug) do nothing;

insert into public.tenant_members (tenant_id, user_id, role)
select t.id, u.id, 'admin'
from public.tenants t
cross join auth.users u
where t.slug = :'tenant_slug'
  and lower(u.email) = lower(:'admin_email')
on conflict (tenant_id, user_id) do update set role = 'admin';

select t.id as tenant_id, t.name, t.slug,
       (select count(*) from public.tenant_members m where m.tenant_id = t.id) as members
from public.tenants t
where t.slug = :'tenant_slug';

commit;
