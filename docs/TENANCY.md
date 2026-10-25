# Tenancy

Site Finder is multi-tenant. Every tenant-scoped row carries a `tenant_id`
that references `public.tenants`, and every policy on those rows goes through
`public.is_tenant_member(tenant_id, min_role)`.

## Model

| Table | Purpose |
|---|---|
| `tenants` | `id`, `name`, unique `slug` |
| `tenant_members` | `(tenant_id, user_id)` with `role` in `admin`, `member`, `viewer` |

Roles rank `viewer < member < admin`. `is_tenant_member(t, min_role)` returns
true when the signed-in user's role in tenant `t` is at least `min_role`. It
fails closed for a null tenant, an unknown role or no session.

Access rules:

- Members read their own tenant and its member list.
- Only admins rename the tenant or add, change and remove members.
- A tenant always keeps one admin. Deleting the tenant or the auth user is
  still allowed.
- Nobody creates tenants from the app. `anon` has no access.

## Operating

Tenants and memberships are data, not migrations, so no tenant id or name
lives in source. Run these by hand with a service-level connection after the
person has signed in once:

```bash
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 \
  -v tenant_name='Example Ltd' -v tenant_slug='example' \
  -v admin_email='admin@example.com' \
  -f scripts/tenancy/create-tenant.sql

psql "$DATABASE_URL" -v ON_ERROR_STOP=1 \
  -v tenant_slug='example' -v member_email='person@example.com' \
  -v member_role='member' \
  -f scripts/tenancy/add-tenant-member.sql
```

Both scripts are safe to re-run and exit non-zero when the tenant or user is
missing.

## Guard rails

`tenant-neutral.test.js` fails if a migration from the tenancy work onwards,
or a tenancy script, names a brand or email domain, or gives `tenant_id` a
default.
