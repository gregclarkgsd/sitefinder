-- Operational script: add a user to an existing tenant, or change their role.
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 \
--     -v tenant_slug='example' \
--     -v member_email='person@example.com' \
--     -v member_role='member' \
--     -f scripts/tenancy/add-tenant-member.sql
--
-- member_role is one of admin, member or viewer. The user must already have
-- signed in once so an auth.users row exists.

\set ON_ERROR_STOP 1

select
  exists (select 1 from public.tenants where slug = :'tenant_slug') as tenant_found,
  exists (select 1 from auth.users where lower(email) = lower(:'member_email')) as member_found
\gset

\if :tenant_found
\else
  do $$ begin raise exception 'No tenant with that slug.'; end $$;
\endif
\if :member_found
\else
  do $$ begin raise exception 'No auth user with that email. Ask them to sign in once, then re-run.'; end $$;
\endif

insert into public.tenant_members (tenant_id, user_id, role)
select t.id, u.id, :'member_role'
from public.tenants t
cross join auth.users u
where t.slug = :'tenant_slug'
  and lower(u.email) = lower(:'member_email')
on conflict (tenant_id, user_id) do update set role = excluded.role
returning tenant_id, user_id, role;
