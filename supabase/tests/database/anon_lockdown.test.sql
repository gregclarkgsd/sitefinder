begin;

create extension if not exists pgtap with schema extensions;

select plan(49);

-- _p3_* : RLS on, anon and authenticated have no privileges, service_role still can.
select ok((select relrowsecurity from pg_class where oid = 'public._p3_batch_scratch'::regclass), '_p3_batch_scratch RLS on');
select ok((select relrowsecurity from pg_class where oid = 'public._p3_co7'::regclass), '_p3_co7 RLS on');
select ok((select relrowsecurity from pg_class where oid = 'public._p3_hist_scratch'::regclass), '_p3_hist_scratch RLS on');
select ok((select relrowsecurity from pg_class where oid = 'public._p3_send_batch'::regclass), '_p3_send_batch RLS on');

select ok(not has_table_privilege('anon', 'public.' || t, p), format('anon cannot %s %s', p, t))
from unnest(array['_p3_batch_scratch','_p3_co7','_p3_hist_scratch','_p3_send_batch']) t,
     unnest(array['SELECT','INSERT','UPDATE','DELETE']) p;
-- 16 tests above

select ok(not has_table_privilege('authenticated', 'public._p3_send_batch', 'SELECT'), 'authenticated cannot read _p3_send_batch');
select ok(has_table_privilege('service_role', 'public._p3_send_batch', 'SELECT,INSERT,UPDATE,DELETE'), 'service_role keeps _p3_send_batch');
select ok(has_table_privilege('service_role', 'public._p3_batch_scratch', 'SELECT,INSERT,UPDATE,DELETE'), 'service_role keeps _p3_batch_scratch');

-- Legacy tables: anon has nothing, no anon policy remains.
select ok(not has_table_privilege('anon', 'public.' || t, 'SELECT,INSERT,UPDATE,DELETE'), format('anon has no access to %s', t))
from unnest(array['agent_definitions','agent_tasks','applications','clients','communications',
                  'compliance','contacts','documents','invoices','projects','variations','workforce']) t;
-- 12 tests above
select is((select count(*)::int from pg_policies where schemaname = 'public' and 'anon' = any(roles)
           and tablename <> 'ccs_project_schedule'), 0, 'no anon policies outside ccs_project_schedule');
select ok(has_table_privilege('service_role', 'public.applications', 'SELECT,INSERT,UPDATE,DELETE'), 'service_role keeps applications');

-- ccs_project_schedule: anon read kept (server.js), anon writes gone.
select ok(has_table_privilege('anon', 'public.ccs_project_schedule', 'SELECT'), 'anon can still read ccs_project_schedule');
select ok(not has_table_privilege('anon', 'public.ccs_project_schedule', 'INSERT'), 'anon cannot insert ccs_project_schedule');
select ok(not has_table_privilege('anon', 'public.ccs_project_schedule', 'UPDATE'), 'anon cannot update ccs_project_schedule');
select ok(not has_table_privilege('anon', 'public.ccs_project_schedule', 'DELETE'), 'anon cannot delete ccs_project_schedule');

-- Views: anon cannot read.
select ok(not has_table_privilege('anon', 'public.v_profitability_dashboard', 'SELECT'), 'anon cannot read v_profitability_dashboard');
select ok(not has_table_privilege('anon', 'public.v_aged_by_contractor', 'SELECT'), 'anon cannot read v_aged_by_contractor');

-- Behaviour, not just catalog: as anon, reads are denied.
set local role anon;
select throws_ok('select 1 from public._p3_send_batch limit 1', '42501', null, 'anon select _p3_send_batch denied');
select throws_ok('delete from public._p3_co7', '42501', null, 'anon delete _p3_co7 denied');
select throws_ok('select 1 from public.applications limit 1', '42501', null, 'anon select applications denied');
select lives_ok('select 1 from public.ccs_project_schedule limit 1', 'anon select ccs_project_schedule still works');
reset role;

-- Authenticated app paths unchanged (spot checks of tables src/ uses).
select ok(has_table_privilege('authenticated', 'public.saved_projects', 'SELECT,INSERT,UPDATE,DELETE'), 'authenticated keeps saved_projects');
select ok(has_table_privilege('authenticated', 'public.outreach_leads', 'SELECT,INSERT,UPDATE'), 'authenticated keeps outreach_leads');

select * from finish();
rollback;
