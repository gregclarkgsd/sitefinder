begin;

create extension if not exists pgtap with schema extensions;

select plan(25);

-- Tenants A and B; an admin, member and viewer in A, a member in B.
insert into auth.users (id, email) values
  ('b1000000-0000-0000-0000-0000000000a1', 'admin@a.test'),
  ('b1000000-0000-0000-0000-0000000000a2', 'member@a.test'),
  ('b1000000-0000-0000-0000-0000000000a3', 'viewer@a.test'),
  ('b1000000-0000-0000-0000-0000000000b1', 'member@b.test');

insert into public.tenants (id, name, slug) values
  ('b2000000-0000-0000-0000-00000000000a', 'Tenant A', 'leads-a'),
  ('b2000000-0000-0000-0000-00000000000b', 'Tenant B', 'leads-b');

insert into public.tenant_members (tenant_id, user_id, role) values
  ('b2000000-0000-0000-0000-00000000000a', 'b1000000-0000-0000-0000-0000000000a1', 'admin'),
  ('b2000000-0000-0000-0000-00000000000a', 'b1000000-0000-0000-0000-0000000000a2', 'member'),
  ('b2000000-0000-0000-0000-00000000000a', 'b1000000-0000-0000-0000-0000000000a3', 'viewer'),
  ('b2000000-0000-0000-0000-00000000000b', 'b1000000-0000-0000-0000-0000000000b1', 'member');

select public.ingest_tender_notices($$[
  {"ocid":"ocds-lead-1","source":"fts","release_id":"r1","title":"Shared notice","source_updated_at":"2026-10-01T09:00:00Z","raw":{}}
]$$::jsonb);

insert into public.tender_tenant_settings (tenant_id, keywords) values
  ('b2000000-0000-0000-0000-00000000000a', array['alpha']),
  ('b2000000-0000-0000-0000-00000000000b', array['beta']);

insert into public.tender_leads (tenant_id, ocid, score, score_breakdown) values
  ('b2000000-0000-0000-0000-00000000000a', 'ocds-lead-1', 70, '{"signals":[]}'),
  ('b2000000-0000-0000-0000-00000000000b', 'ocds-lead-1', 30, '{"signals":[]}');

-- Schema.
select ok(
  not has_table_privilege('anon', 'public.tender_tenant_settings', 'select')
  and not has_table_privilege('anon', 'public.tender_leads', 'select'),
  'anon cannot read tender settings or leads'
);
select ok(
  not has_table_privilege('authenticated', 'public.tender_leads', 'insert, delete'),
  'only the service role creates or deletes leads'
);
select ok(
  not has_column_privilege('authenticated', 'public.tender_leads', 'score', 'update')
  and not has_column_privilege('authenticated', 'public.tender_leads', 'crm_record_id', 'update'),
  'users cannot change scores or CRM fields'
);
select throws_ok(
  $$ insert into public.tender_leads (ocid, score, score_breakdown) values ('ocds-lead-1', 10, '{}') $$,
  '23502', null,
  'a lead with no tenant is rejected'
);
select throws_ok(
  $$ insert into public.tender_tenant_settings (keywords) values ('{}') $$,
  '23502', null,
  'settings with no tenant are rejected'
);
select throws_ok(
  $$ insert into public.tender_leads (tenant_id, ocid, score, score_breakdown)
     values ('b2000000-0000-0000-0000-00000000000a', 'ocds-lead-1', 101, '{}') $$,
  '23514', null,
  'scores are limited to 0-100'
);
select is(
  (select array_length(array(select jsonb_object_keys(stages)), 1) from public.tender_tenant_settings
   where tenant_id = 'b2000000-0000-0000-0000-00000000000a'),
  8,
  'each tenant starts with the eight standard stage labels'
);
select is(
  (select cpv_primary || regions || buyer_allow from public.tender_tenant_settings
   where tenant_id = 'b2000000-0000-0000-0000-00000000000b'),
  '{}'::text[],
  'match lists start empty'
);
select throws_ok(
  $$ update public.tender_tenant_settings set min_value = 10, max_value = 5
     where tenant_id = 'b2000000-0000-0000-0000-00000000000a' $$,
  '23514', null,
  'the value band cannot be inverted'
);

-- Member of A.
select set_config('request.jwt.claims', '{"sub":"b1000000-0000-0000-0000-0000000000a2","role":"authenticated"}', true);
set local role authenticated;
select is((select count(*) from public.tender_leads), 1::bigint, 'member of A sees only A''s leads');
select is((select score from public.tender_leads), 70, 'the visible lead is A''s');
select is((select count(*) from public.tender_tenant_settings), 1::bigint, 'member of A sees only A''s settings');
select lives_ok(
  $$ update public.tender_leads set status = 'bidding', updated_by = 'b1000000-0000-0000-0000-0000000000a2'
     where tenant_id = 'b2000000-0000-0000-0000-00000000000a' $$,
  'a member can move a lead to Bidding'
);
update public.tender_leads set status = 'dismissed', updated_by = 'b1000000-0000-0000-0000-0000000000a2'
where tenant_id = 'b2000000-0000-0000-0000-00000000000b';
select throws_ok(
  $$ update public.tender_leads set status = 'won_big', updated_by = 'b1000000-0000-0000-0000-0000000000a2'
     where tenant_id = 'b2000000-0000-0000-0000-00000000000a' $$,
  '23514', null,
  'unknown statuses are rejected'
);
select throws_ok(
  $$ update public.tender_leads set score = 100 where tenant_id = 'b2000000-0000-0000-0000-00000000000a' $$,
  '42501', null,
  'a member cannot change a score'
);
select throws_ok(
  $$ update public.tender_leads set assigned_to = 'b1000000-0000-0000-0000-0000000000b1',
       updated_by = 'b1000000-0000-0000-0000-0000000000a2'
     where tenant_id = 'b2000000-0000-0000-0000-00000000000a' $$,
  '23514', null,
  'a lead cannot be assigned to someone outside the tenant'
);
select lives_ok(
  $$ update public.tender_leads set assigned_to = 'b1000000-0000-0000-0000-0000000000a1',
       updated_by = 'b1000000-0000-0000-0000-0000000000a2'
     where tenant_id = 'b2000000-0000-0000-0000-00000000000a' $$,
  'a lead can be assigned to a colleague'
);
update public.tender_tenant_settings set keywords = array['changed'], updated_by = 'b1000000-0000-0000-0000-0000000000a2';
reset role;
select is(
  (select status from public.tender_leads where tenant_id = 'b2000000-0000-0000-0000-00000000000b'),
  'to_qualify', 'member of A cannot update B''s lead'
);
select is(
  (select keywords from public.tender_tenant_settings where tenant_id = 'b2000000-0000-0000-0000-00000000000a'),
  array['alpha'], 'a non-admin member cannot edit settings'
);

-- Viewer of A.
select set_config('request.jwt.claims', '{"sub":"b1000000-0000-0000-0000-0000000000a3","role":"authenticated"}', true);
set local role authenticated;
update public.tender_leads set status = 'lost', updated_by = 'b1000000-0000-0000-0000-0000000000a3';
update public.tender_tenant_settings set keywords = array['viewer'], updated_by = 'b1000000-0000-0000-0000-0000000000a3';
reset role;
select is(
  (select status from public.tender_leads where tenant_id = 'b2000000-0000-0000-0000-00000000000a'),
  'bidding', 'a viewer cannot change lead status'
);
select is(
  (select keywords from public.tender_tenant_settings where tenant_id = 'b2000000-0000-0000-0000-00000000000a'),
  array['alpha'], 'a viewer cannot edit settings'
);

-- Admin of A.
select set_config('request.jwt.claims', '{"sub":"b1000000-0000-0000-0000-0000000000a1","role":"authenticated"}', true);
set local role authenticated;
select lives_ok(
  $$ update public.tender_tenant_settings set keywords = array['repaint'], updated_by = 'b1000000-0000-0000-0000-0000000000a1'
     where tenant_id = 'b2000000-0000-0000-0000-00000000000a' $$,
  'an admin can edit settings'
);
select is(
  (select settings_version from public.tender_tenant_settings where tenant_id = 'b2000000-0000-0000-0000-00000000000a'),
  2, 'changing match rules bumps the settings version'
);
update public.tender_tenant_settings set digest_enabled = true, updated_by = 'b1000000-0000-0000-0000-0000000000a1'
where tenant_id = 'b2000000-0000-0000-0000-00000000000a';
select is(
  (select settings_version from public.tender_tenant_settings where tenant_id = 'b2000000-0000-0000-0000-00000000000a'),
  2, 'non-scoring changes keep the settings version'
);
update public.tender_tenant_settings set keywords = array['x'], updated_by = 'b1000000-0000-0000-0000-0000000000a1'
where tenant_id = 'b2000000-0000-0000-0000-00000000000b';
reset role;
select is(
  (select keywords from public.tender_tenant_settings where tenant_id = 'b2000000-0000-0000-0000-00000000000b'),
  array['beta'], 'an admin of A cannot edit B''s settings'
);

select * from finish();
rollback;
