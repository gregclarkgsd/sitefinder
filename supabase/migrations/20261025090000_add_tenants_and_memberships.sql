-- Tenant model for Site Finder. Every tenant-scoped table references
-- public.tenants and is gated by public.is_tenant_member(). Tenants and their
-- first admin are created operationally (scripts/tenancy/create-tenant.sql),
-- so no tenant id, name or email domain lives in source.

create table public.tenants (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(btrim(name)) between 1 and 200),
  slug text not null unique check (
    length(slug) between 1 and 63
    and slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'
  ),
  created_at timestamptz not null default now()
);

create table public.tenant_members (
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null check (role in ('admin', 'member', 'viewer')),
  created_at timestamptz not null default now(),
  primary key (tenant_id, user_id)
);

create index tenant_members_user_id_idx on public.tenant_members (user_id);

-- Roles are ranked viewer < member < admin. An unknown min_role, a null
-- tenant or a missing auth.uid() all fail closed.
create function public.is_tenant_member(t uuid, min_role text default 'viewer')
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((
    select
      case m.role when 'admin' then 3 when 'member' then 2 when 'viewer' then 1 end
      >= case min_role when 'admin' then 3 when 'member' then 2 when 'viewer' then 1 end
    from public.tenant_members m
    where m.tenant_id = t
      and m.user_id = (select auth.uid())
  ), false);
$$;

revoke all on function public.is_tenant_member(uuid, text) from public, anon;
grant execute on function public.is_tenant_member(uuid, text) to authenticated, service_role;

-- A tenant must always keep at least one admin. Cascading deletes of the
-- tenant itself or of the auth user are allowed through.
create function private.keep_last_tenant_admin()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if old.role <> 'admin' then
    return null;
  end if;
  if tg_op = 'UPDATE' and new.role = 'admin' and new.tenant_id = old.tenant_id then
    return null;
  end if;
  if not exists (select 1 from public.tenants where id = old.tenant_id) then
    return null;
  end if;
  if not exists (select 1 from auth.users where id = old.user_id) then
    return null;
  end if;
  if not exists (
    select 1 from public.tenant_members
    where tenant_id = old.tenant_id and role = 'admin'
  ) then
    raise exception 'tenant % must keep at least one admin', old.tenant_id
      using errcode = '23514';
  end if;
  return null;
end;
$$;

revoke all on function private.keep_last_tenant_admin() from public, anon, authenticated;

create trigger keep_last_tenant_admin
after update or delete on public.tenant_members
for each row execute function private.keep_last_tenant_admin();

alter table public.tenants enable row level security;
alter table public.tenant_members enable row level security;

revoke all on public.tenants from public, anon, authenticated;
revoke all on public.tenant_members from public, anon, authenticated;

grant select on public.tenants to authenticated;
grant update (name) on public.tenants to authenticated;
grant select, insert, delete on public.tenant_members to authenticated;
grant update (role) on public.tenant_members to authenticated;
grant all on public.tenants, public.tenant_members to service_role;

create policy "Members can read their tenants"
on public.tenants for select to authenticated
using (public.is_tenant_member(id));

create policy "Admins can rename their tenant"
on public.tenants for update to authenticated
using (public.is_tenant_member(id, 'admin'))
with check (public.is_tenant_member(id, 'admin'));

create policy "Members can read co-members"
on public.tenant_members for select to authenticated
using (public.is_tenant_member(tenant_id));

create policy "Admins can add members"
on public.tenant_members for insert to authenticated
with check (public.is_tenant_member(tenant_id, 'admin'));

create policy "Admins can change member roles"
on public.tenant_members for update to authenticated
using (public.is_tenant_member(tenant_id, 'admin'))
with check (public.is_tenant_member(tenant_id, 'admin'));

create policy "Admins can remove members"
on public.tenant_members for delete to authenticated
using (public.is_tenant_member(tenant_id, 'admin'));
