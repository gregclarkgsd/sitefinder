begin;

create extension if not exists pgtap with schema extensions;

select plan(30);

-- Two tenants with an admin, a member and a viewer in A, and an admin in B.
insert into auth.users (id, email) values
  ('30000000-0000-0000-0000-00000000000a', 'admin-a@tenant-a.test'),
  ('30000000-0000-0000-0000-00000000000b', 'member-a@tenant-a.test'),
  ('30000000-0000-0000-0000-00000000000c', 'viewer-a@tenant-a.test'),
  ('30000000-0000-0000-0000-00000000000d', 'admin-b@tenant-b.test'),
  ('30000000-0000-0000-0000-00000000000e', 'newcomer@tenant-a.test'),
  ('30000000-0000-0000-0000-00000000000f', 'nobody@elsewhere.test');

insert into public.tenants (id, name, slug) values
  ('40000000-0000-0000-0000-00000000000a', 'Tenant A', 'tenant-a'),
  ('40000000-0000-0000-0000-00000000000b', 'Tenant B', 'tenant-b');

insert into public.tenant_members (tenant_id, user_id, role) values
  ('40000000-0000-0000-0000-00000000000a', '30000000-0000-0000-0000-00000000000a', 'admin'),
  ('40000000-0000-0000-0000-00000000000a', '30000000-0000-0000-0000-00000000000b', 'member'),
  ('40000000-0000-0000-0000-00000000000a', '30000000-0000-0000-0000-00000000000c', 'viewer'),
  ('40000000-0000-0000-0000-00000000000b', '30000000-0000-0000-0000-00000000000d', 'admin');

select ok((select relrowsecurity from pg_class where oid = 'public.tenants'::regclass), 'tenants has RLS enabled');
select ok((select relrowsecurity from pg_class where oid = 'public.tenant_members'::regclass), 'tenant_members has RLS enabled');
select ok(not has_table_privilege('anon', 'public.tenants', 'select, insert, update, delete'), 'anon has no access to tenants');
select ok(not has_table_privilege('anon', 'public.tenant_members', 'select, insert, update, delete'), 'anon has no access to tenant_members');
select ok(not has_function_privilege('anon', 'public.is_tenant_member(uuid, text)', 'execute'), 'anon cannot call is_tenant_member');
select ok(not has_table_privilege('authenticated', 'public.tenants', 'insert, delete'), 'authenticated cannot create or delete tenants');
select ok(not has_column_privilege('authenticated', 'public.tenants', 'slug', 'update'), 'authenticated cannot change a tenant slug');

select throws_ok(
  $$ insert into public.tenant_members (tenant_id, user_id, role)
     values ('40000000-0000-0000-0000-00000000000a', '30000000-0000-0000-0000-00000000000e', 'owner') $$,
  '23514', null, 'unknown roles are rejected'
);

-- Member of A.
select set_config('request.jwt.claims', '{"sub":"30000000-0000-0000-0000-00000000000b","role":"authenticated"}', true);
set local role authenticated;
select is((select count(*) from public.tenants), 1::bigint, 'a member sees only their own tenant');
select is((select name from public.tenants), 'Tenant A', 'the visible tenant is the member''s tenant');
select is((select count(*) from public.tenant_members), 3::bigint, 'a member sees only co-members of their tenant');
select ok(public.is_tenant_member('40000000-0000-0000-0000-00000000000a'), 'member passes the viewer check for their tenant');
select ok(public.is_tenant_member('40000000-0000-0000-0000-00000000000a', 'member'), 'member passes the member check');
select ok(not public.is_tenant_member('40000000-0000-0000-0000-00000000000a', 'admin'), 'member fails the admin check');
select ok(not public.is_tenant_member('40000000-0000-0000-0000-00000000000b'), 'member of A is not a member of B');
select ok(not public.is_tenant_member('40000000-0000-0000-0000-00000000000a', 'owner'), 'an unknown min_role fails closed');
select ok(not public.is_tenant_member(null), 'a null tenant fails closed');
select throws_ok(
  $$ insert into public.tenant_members (tenant_id, user_id, role)
     values ('40000000-0000-0000-0000-00000000000a', '30000000-0000-0000-0000-00000000000e', 'member') $$,
  '42501', null, 'a member cannot add members'
);
update public.tenant_members set role = 'admin' where user_id = '30000000-0000-0000-0000-00000000000c';
update public.tenants set name = 'Renamed by member' where id = '40000000-0000-0000-0000-00000000000a';
reset role;
select is(
  (select role from public.tenant_members where user_id = '30000000-0000-0000-0000-00000000000c'),
  'viewer', 'a member cannot change roles'
);
select is(
  (select name from public.tenants where id = '40000000-0000-0000-0000-00000000000a'),
  'Tenant A', 'a member cannot rename the tenant'
);

-- Viewer of A.
select set_config('request.jwt.claims', '{"sub":"30000000-0000-0000-0000-00000000000c","role":"authenticated"}', true);
set local role authenticated;
select ok(not public.is_tenant_member('40000000-0000-0000-0000-00000000000a', 'member'), 'viewer fails the member check');
reset role;

-- Admin of A.
select set_config('request.jwt.claims', '{"sub":"30000000-0000-0000-0000-00000000000a","role":"authenticated"}', true);
set local role authenticated;
select lives_ok(
  $$ insert into public.tenant_members (tenant_id, user_id, role)
     values ('40000000-0000-0000-0000-00000000000a', '30000000-0000-0000-0000-00000000000e', 'member') $$,
  'an admin can add a member to their tenant'
);
select throws_ok(
  $$ insert into public.tenant_members (tenant_id, user_id, role)
     values ('40000000-0000-0000-0000-00000000000b', '30000000-0000-0000-0000-00000000000e', 'admin') $$,
  '42501', null, 'an admin of A cannot add members to B'
);
select lives_ok(
  $$ update public.tenants set name = 'Tenant A Renamed' where id = '40000000-0000-0000-0000-00000000000a' $$,
  'an admin can rename their tenant'
);
select throws_ok(
  $$ update public.tenant_members set role = 'member' where user_id = '30000000-0000-0000-0000-00000000000a' $$,
  '23514', null, 'the last admin cannot demote themselves'
);
select throws_ok(
  $$ delete from public.tenant_members where user_id = '30000000-0000-0000-0000-00000000000a' $$,
  '23514', null, 'the last admin cannot be removed'
);
update public.tenant_members set role = 'admin' where user_id = '30000000-0000-0000-0000-00000000000b';
select lives_ok(
  $$ delete from public.tenant_members where user_id = '30000000-0000-0000-0000-00000000000a' $$,
  'an admin can leave once another admin exists'
);
reset role;

-- No session.
select set_config('request.jwt.claims', '{}', true);
select ok(not public.is_tenant_member('40000000-0000-0000-0000-00000000000a'), 'no auth.uid() fails closed');

-- Cascades bypass the last-admin guard.
select lives_ok(
  $$ delete from auth.users where id = '30000000-0000-0000-0000-00000000000d' $$,
  'deleting the auth user of a last admin is allowed'
);
select lives_ok(
  $$ delete from public.tenants where id = '40000000-0000-0000-0000-00000000000a' $$,
  'deleting a tenant cascades its members'
);

select * from finish();
rollback;
