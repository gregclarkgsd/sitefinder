begin;

create extension if not exists pgtap with schema extensions;

select plan(44);

-- Transaction-local fixtures let the suite prove policy behaviour, rather
-- than only inspecting grants and policy text in the system catalog.
insert into public.research_runs (id, name, company_limit)
values ('10000000-0000-0000-0000-000000000001', 'pgTAP RLS fixture', 1);

insert into public.research_tasks (
  id, run_id, company_id, company_name, domain
)
values (
  '10000000-0000-0000-0000-000000000002',
  '10000000-0000-0000-0000-000000000001',
  'pgtap-company',
  'pgTAP Company',
  'pgtap.example'
);

insert into public.research_events (
  run_id, task_id, sequence, event_type, message
)
values (
  '10000000-0000-0000-0000-000000000001',
  '10000000-0000-0000-0000-000000000002',
  1,
  'run',
  'pgTAP event'
);

insert into public.research_candidates (
  id,
  run_id,
  task_id,
  external_candidate_id,
  company_id,
  name,
  job_title,
  role_category,
  source_kind,
  source_url,
  crm_comparison,
  email_status,
  confidence
)
values (
  '10000000-0000-0000-0000-000000000003',
  '10000000-0000-0000-0000-000000000001',
  '10000000-0000-0000-0000-000000000002',
  'pgtap-candidate',
  'pgtap-company',
  'pgTAP Person',
  'Commercial Manager',
  'commercial',
  'official_website',
  'https://pgtap.example/team',
  'missing_from_both',
  'public_email_found',
  0.900
);

insert into public.attio_sync_links (
  entity_type, source_key, source_name, attio_object_slug, sync_status
)
values ('company', 'pgtap:company', 'pgTAP Company', 'companies', 'pending');

insert into public.ccs_project_schedule (
  project_id, site_start_date, site_end_date, is_active
)
values ('pgtap-project', current_date, current_date + 30, true);

-- Research Agent tables are private observability/review state. Their access
-- is deliberately read-only for authenticated GSD staff and unavailable to
-- anonymous clients; workers use server-side credentials instead.
select ok(
  (select relrowsecurity from pg_class where oid = 'public.research_runs'::regclass),
  'research_runs has row level security enabled'
);
select ok(
  (select relrowsecurity from pg_class where oid = 'public.research_tasks'::regclass),
  'research_tasks has row level security enabled'
);
select ok(
  (select relrowsecurity from pg_class where oid = 'public.research_events'::regclass),
  'research_events has row level security enabled'
);
select ok(
  (select relrowsecurity from pg_class where oid = 'public.research_candidates'::regclass),
  'research_candidates has row level security enabled'
);

select ok(
  not has_table_privilege('anon', 'public.research_runs', 'select'),
  'anon cannot read research runs'
);
select ok(
  not has_table_privilege('anon', 'public.research_tasks', 'select'),
  'anon cannot read research tasks'
);
select ok(
  not has_table_privilege('anon', 'public.research_events', 'select'),
  'anon cannot read research events'
);
select ok(
  not has_table_privilege('anon', 'public.research_candidates', 'select'),
  'anon cannot read research candidates'
);

select ok(
  has_table_privilege('authenticated', 'public.research_runs', 'select')
  and not has_table_privilege('authenticated', 'public.research_runs', 'insert, update, delete'),
  'authenticated research-run access is read-only'
);
select ok(
  has_table_privilege('authenticated', 'public.research_tasks', 'select')
  and not has_table_privilege('authenticated', 'public.research_tasks', 'insert, update, delete'),
  'authenticated research-task access is read-only'
);
select ok(
  has_table_privilege('authenticated', 'public.research_events', 'select')
  and not has_table_privilege('authenticated', 'public.research_events', 'insert, update, delete'),
  'authenticated research-event access is read-only'
);
select ok(
  has_table_privilege('authenticated', 'public.research_candidates', 'select')
  and not has_table_privilege('authenticated', 'public.research_candidates', 'insert, update, delete'),
  'authenticated research-candidate access is read-only'
);

select set_config(
  'request.jwt.claims',
  '{"sub":"20000000-0000-0000-0000-000000000001","email":"outsider@example.com"}',
  true
);
set local role authenticated;
select is(
  (select count(*) from public.research_runs where id = '10000000-0000-0000-0000-000000000001'),
  0::bigint,
  'authenticated outsiders cannot see research runs'
);
select is(
  (select count(*) from public.research_tasks where id = '10000000-0000-0000-0000-000000000002'),
  0::bigint,
  'authenticated outsiders cannot see research tasks'
);
select is(
  (select count(*) from public.research_events where run_id = '10000000-0000-0000-0000-000000000001'),
  0::bigint,
  'authenticated outsiders cannot see research events'
);
select is(
  (select count(*) from public.research_candidates where id = '10000000-0000-0000-0000-000000000003'),
  0::bigint,
  'authenticated outsiders cannot see research candidates'
);
reset role;

select set_config(
  'request.jwt.claims',
  '{"sub":"20000000-0000-0000-0000-000000000002","email":"tester@gsdecorating.com"}',
  true
);
set local role authenticated;
select is(
  (select count(*) from public.research_runs where id = '10000000-0000-0000-0000-000000000001'),
  1::bigint,
  'authenticated GSD users can see research runs'
);
select is(
  (select count(*) from public.research_tasks where id = '10000000-0000-0000-0000-000000000002'),
  1::bigint,
  'authenticated GSD users can see research tasks'
);
select is(
  (select count(*) from public.research_events where run_id = '10000000-0000-0000-0000-000000000001'),
  1::bigint,
  'authenticated GSD users can see research events'
);
select is(
  (select count(*) from public.research_candidates where id = '10000000-0000-0000-0000-000000000003'),
  1::bigint,
  'authenticated GSD users can see research candidates'
);
reset role;

-- Research rows must stay tied to the run/task that produced them, including
-- cascade cleanup when a run is deleted.
select ok(
  exists (
    select 1 from pg_constraint
    where contype = 'f'
      and conrelid = 'public.research_tasks'::regclass
      and confrelid = 'public.research_runs'::regclass
      and confdeltype = 'c'
  ),
  'research tasks cascade from their research run'
);
select ok(
  exists (
    select 1 from pg_constraint
    where contype = 'f'
      and conrelid = 'public.research_events'::regclass
      and confrelid = 'public.research_runs'::regclass
      and confdeltype = 'c'
  ),
  'research events cascade from their research run'
);
select ok(
  exists (
    select 1 from pg_constraint
    where contype = 'f'
      and conrelid = 'public.research_events'::regclass
      and confrelid = 'public.research_tasks'::regclass
      and confdeltype = 'c'
  ),
  'research events cascade from their research task when present'
);
select ok(
  exists (
    select 1 from pg_constraint
    where contype = 'f'
      and conrelid = 'public.research_candidates'::regclass
      and confrelid = 'public.research_runs'::regclass
      and confdeltype = 'c'
  ),
  'research candidates cascade from their research run'
);
select ok(
  exists (
    select 1 from pg_constraint
    where contype = 'f'
      and conrelid = 'public.research_candidates'::regclass
      and confrelid = 'public.research_tasks'::regclass
      and confdeltype = 'c'
  ),
  'research candidates cascade from their research task'
);
set local session_replication_role = replica;
select throws_ok(
  $$
    insert into public.research_candidates (
      id,
      run_id,
      task_id,
      external_candidate_id,
      company_id,
      name,
      job_title,
      role_category,
      source_kind,
      source_url,
      crm_comparison,
      email_status,
      confidence,
      review_status,
      reviewed_by,
      reviewed_at
    )
    values (
      '10000000-0000-0000-0000-000000000004',
      '10000000-0000-0000-0000-000000000001',
      '10000000-0000-0000-0000-000000000002',
      'pgtap-ineligible-approved',
      'pgtap-company',
      'Ineligible Person',
      'Commercial Manager',
      'commercial',
      'official_website',
      'https://pgtap.example/ineligible',
      'already_in_attio',
      'public_email_found',
      0.900,
      'approved',
      '20000000-0000-0000-0000-000000000002',
      now()
    )
  $$,
  '23514',
  'new row for relation "research_candidates" violates check constraint "research_candidates_approval_eligibility_check"',
  'database rejects an ineligible approved research candidate'
);
select lives_ok(
  $$
    insert into public.research_candidates (
      id,
      run_id,
      task_id,
      external_candidate_id,
      company_id,
      name,
      job_title,
      role_category,
      source_kind,
      source_url,
      crm_comparison,
      email_status,
      confidence,
      review_status,
      reviewed_by,
      reviewed_at
    )
    values (
      '10000000-0000-0000-0000-000000000005',
      '10000000-0000-0000-0000-000000000001',
      '10000000-0000-0000-0000-000000000002',
      'pgtap-eligible-approved',
      'pgtap-company',
      'Eligible Person',
      'Commercial Manager',
      'commercial',
      'official_website',
      'https://pgtap.example/eligible',
      'missing_from_both',
      'public_email_found',
      0.900,
      'approved',
      '20000000-0000-0000-0000-000000000002',
      now()
    )
  $$,
  'database accepts an eligible approved research candidate'
);
set local session_replication_role = origin;
select ok(
  exists (
    select 1
    from pg_constraint
    where conrelid = 'public.research_events'::regclass
      and contype = 'u'
      and pg_get_constraintdef(oid) = 'UNIQUE (run_id, sequence)'
  )
  and exists (
    select 1
    from pg_indexes
    where schemaname = 'public'
      and tablename = 'research_events'
      and indexname = 'research_events_claim_sequence_uidx'
      and indexdef like 'CREATE UNIQUE INDEX%'
      and indexdef like '%(claim_id, sequence)%'
      and indexdef like '%WHERE (claim_id IS NOT NULL)%'
  ),
  'research events preserve legacy upsert identity and add claim identity'
);
select ok(
  exists (
    select 1 from pg_constraint
    where conrelid = 'public.research_tasks'::regclass
      and contype = 'u'
      and pg_get_constraintdef(oid) = 'UNIQUE (run_id, company_id)'
  ),
  'research tasks have one company per run'
);

-- Outreach records are also private. Keeping this separate catches a future
-- broad grant even if RLS policies have not changed.
select ok(not has_table_privilege('anon', 'public.outreach_leads', 'select'), 'anon cannot read outreach leads');
select ok(not has_table_privilege('anon', 'public.outreach_communications', 'select'), 'anon cannot read outreach communications');
select ok(not has_table_privilege('anon', 'public.outreach_suppressions', 'select'), 'anon cannot read outreach suppressions');
select ok(not has_table_privilege('anon', 'public.outreach_mailbox_state', 'select'), 'anon cannot read mailbox credentials or state');
select ok(not has_table_privilege('anon', 'public.outreach_oauth_states', 'select'), 'anon cannot read OAuth states');

-- Attio linkage is deliberately visible to GSD staff only as a read model.
select ok(
  (select relrowsecurity from pg_class where oid = 'public.attio_sync_links'::regclass),
  'Attio sync links have row level security enabled'
);
select ok(
  not has_table_privilege('anon', 'public.attio_sync_links', 'select'),
  'anon cannot read Attio sync links'
);
select ok(
  has_table_privilege('authenticated', 'public.attio_sync_links', 'select'),
  'authenticated users can read Attio sync links'
);
select ok(
  not has_table_privilege('authenticated', 'public.attio_sync_links', 'insert, update, delete'),
  'authenticated Attio sync-link access is read-only'
);
select set_config(
  'request.jwt.claims',
  '{"sub":"20000000-0000-0000-0000-000000000001","email":"outsider@example.com"}',
  true
);
set local role authenticated;
select is(
  (select count(*) from public.attio_sync_links where source_key = 'pgtap:company'),
  0::bigint,
  'authenticated outsiders cannot see Attio sync links'
);
reset role;

select set_config(
  'request.jwt.claims',
  '{"sub":"20000000-0000-0000-0000-000000000002","email":"tester@gsdecorating.com"}',
  true
);
set local role authenticated;
select is(
  (select count(*) from public.attio_sync_links where source_key = 'pgtap:company'),
  1::bigint,
  'authenticated GSD users can see Attio sync links'
);
reset role;

-- The public CCS schedule is intentionally the one public read model. It
-- remains select-only and keeps RLS enabled so writes cannot leak in later.
select ok(
  (select relrowsecurity from pg_class where oid = 'public.ccs_project_schedule'::regclass),
  'public CCS schedule has row level security enabled'
);
select set_config('request.jwt.claims', '{}', true);
set local role anon;
select is(
  (select count(*) from public.ccs_project_schedule where project_id = 'pgtap-project'),
  1::bigint,
  'anon clients can read the public CCS schedule'
);
reset role;

select set_config(
  'request.jwt.claims',
  '{"sub":"20000000-0000-0000-0000-000000000001","email":"outsider@example.com"}',
  true
);
set local role authenticated;
select is(
  (select count(*) from public.ccs_project_schedule where project_id = 'pgtap-project'),
  1::bigint,
  'authenticated clients can read the public CCS schedule'
);
reset role;
select ok(
  not has_table_privilege('anon', 'public.ccs_project_schedule', 'insert, update, delete')
  and not has_table_privilege('authenticated', 'public.ccs_project_schedule', 'insert, update, delete'),
  'CCS schedule remains select-only under RLS'
);

select * from finish();
rollback;
