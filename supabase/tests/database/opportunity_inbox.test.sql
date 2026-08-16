begin;

create extension if not exists pgtap with schema extensions;

select plan(40);

select ok(
  (
    select count(*) = 7
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'lead_tracking'
      and column_name in (
        'triage_status',
        'reviewed_at',
        'contacted_at',
        'contacted_source',
        'snoozed_until',
        'review_note',
        'triage_updated_by'
      )
  ),
  'lead tracking contains every durable Opportunity Inbox field'
);

select ok(
  exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'ccs_projects'
      and column_name = 'last_changed_fields'
      and data_type = 'ARRAY'
  ),
  'CCS history stores exact changed-field evidence'
);

select is(
  (
    select column_default
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'lead_tracking'
      and column_name = 'triage_status'
  ),
  '''unreviewed''::text',
  'new lead tracking rows default to unreviewed'
);

select ok(
  exists (
    select 1
    from pg_constraint
    where conrelid = 'public.lead_tracking'::regclass
      and conname = 'lead_tracking_triage_status_check'
      and pg_get_constraintdef(oid) like '%unreviewed%'
      and pg_get_constraintdef(oid) like '%not_fit%'
  ),
  'triage status is constrained to the reviewed workflow'
);

select ok(
  exists (
    select 1
    from pg_constraint
    where conrelid = 'public.lead_tracking'::regclass
      and conname = 'lead_tracking_contacted_source_check'
      and pg_get_constraintdef(oid) like '%manual_history%'
      and pg_get_constraintdef(oid) like '%pipeline_stage%'
      and pg_get_constraintdef(oid) like '%contacted_at IS NOT NULL%'
  ),
  'manual and pipeline contact provenance require contact evidence'
);

select ok(
  exists (
    select 1
    from pg_indexes
    where schemaname = 'public'
      and tablename = 'ccs_sync_runs'
      and indexname = 'ccs_sync_runs_single_running_idx'
      and indexdef like '%WHERE (status = ''running''::text)%'
  ),
  'only one CCS sync can hold the running lease'
);

select ok(
  exists (
    select 1
    from pg_indexes
    where schemaname = 'public'
      and tablename = 'lead_tracking'
      and indexname = 'lead_tracking_triage_idx'
  ),
  'Opportunity Inbox team decisions have a supporting index'
);

select ok(
  (select relrowsecurity from pg_class where oid = 'public.opportunity_inbox_cursors'::regclass),
  'personal Opportunity Inbox checkpoints have row level security enabled'
);

select ok(
  not has_table_privilege('anon', 'public.opportunity_inbox_cursors', 'select, insert, update, delete'),
  'anonymous clients cannot access personal Opportunity Inbox checkpoints'
);

select ok(
  has_table_privilege('authenticated', 'public.opportunity_inbox_cursors', 'select, insert, update'),
  'authenticated users have the explicit Data API grants needed for their checkpoint'
);

select ok(
  not has_table_privilege('authenticated', 'public.opportunity_inbox_cursors', 'delete'),
  'authenticated users cannot delete checkpoint audit rows'
);

select is(
  (
    select count(*)
    from pg_policies
    where schemaname = 'public'
      and tablename = 'opportunity_inbox_cursors'
  ),
  3::bigint,
  'checkpoint access has explicit select, insert and update policies'
);

select ok(
  (
    select bool_and(
      coalesce(qual, '') like '%auth.uid%'
      or coalesce(with_check, '') like '%auth.uid%'
    )
    from pg_policies
    where schemaname = 'public'
      and tablename = 'opportunity_inbox_cursors'
  ),
  'every checkpoint policy binds access to the authenticated user'
);

select ok(
  (
    select bool_and(
      coalesce(qual, '') like '%gsdecorating.com%'
      or coalesce(with_check, '') like '%gsdecorating.com%'
    )
    from pg_policies
    where schemaname = 'public'
      and tablename = 'opportunity_inbox_cursors'
  ),
  'every checkpoint policy retains the GSD employee boundary'
);

select ok(
  exists (
    select 1
    from pg_constraint
    where conrelid = 'public.opportunity_inbox_cursors'::regclass
      and confrelid = 'auth.users'::regclass
      and contype = 'f'
      and confdeltype = 'c'
  ),
  'checkpoint rows cascade when their owning auth user is deleted'
);

select ok(
  exists (
    select 1
    from pg_constraint
    where conrelid = 'public.opportunity_inbox_cursors'::regclass
      and conname = 'opportunity_inbox_cursor_time_check'
  ),
  'checkpoint timestamps cannot be later than their audit update'
);

select ok(
  has_table_privilege('service_role', 'public.opportunity_inbox_cursors', 'select, insert, update, delete'),
  'server-side maintenance retains full checkpoint access'
);

select ok(
  exists (
    select 1
    from pg_trigger
    where tgrelid = 'public.lead_tracking'::regclass
      and tgname = 'enforce_lead_tracking_triage_audit'
      and not tgisinternal
  ),
  'lead triage decisions have a server-side audit trigger'
);

select ok(
  not has_function_privilege(
    'authenticated',
    'public.enforce_lead_tracking_triage_audit()',
    'execute'
  ),
  'authenticated clients cannot call the audit trigger function directly'
);

select ok(
  exists (
    select 1
    from pg_trigger
    where tgrelid = 'public.opportunity_inbox_cursors'::regclass
      and tgname = 'enforce_opportunity_checkpoint_actor_time'
      and not tgisinternal
  ),
  'checkpoint ownership and time are enforced by a server-side trigger'
);

select ok(
  not has_function_privilege(
    'authenticated',
    'public.enforce_opportunity_checkpoint_actor_time()',
    'execute'
  ),
  'authenticated clients cannot call the checkpoint trigger function directly'
);

select ok(
  has_function_privilege(
    'authenticated',
    'public.capture_opportunity_evidence_cutoff()',
    'execute'
  )
  and not has_function_privilege(
    'anon',
    'public.capture_opportunity_evidence_cutoff()',
    'execute'
  ),
  'only authenticated clients can capture a server evidence cutoff'
);

select ok(
  (select relrowsecurity from pg_class where oid = 'public.opportunity_triage_events'::regclass),
  'append-only Opportunity decision history has row level security enabled'
);

select ok(
  has_table_privilege('authenticated', 'public.opportunity_triage_events', 'select')
  and not has_table_privilege(
    'authenticated',
    'public.opportunity_triage_events',
    'insert, update, delete'
  ),
  'authenticated users can read but cannot rewrite Opportunity decision history'
);

select ok(
  exists (
    select 1
    from pg_trigger
    where tgrelid = 'public.lead_tracking'::regclass
      and tgname = 'record_opportunity_triage_event'
      and not tgisinternal
  ),
  'Opportunity decisions are copied to append-only history by a trigger'
);

select ok(
  not has_table_privilege('authenticated', 'public.lead_tracking', 'delete'),
  'authenticated users cannot erase durable Opportunity state'
);

insert into auth.users (
  id,
  aud,
  role,
  email,
  encrypted_password,
  email_confirmed_at,
  raw_app_meta_data,
  raw_user_meta_data,
  created_at,
  updated_at
)
values
  (
    '30000000-0000-0000-0000-000000000001',
    'authenticated',
    'authenticated',
    'outside@example.com',
    '',
    now(),
    '{}'::jsonb,
    '{}'::jsonb,
    now(),
    now()
  ),
  (
    '30000000-0000-0000-0000-000000000002',
    'authenticated',
    'authenticated',
    'alice@gsdecorating.com',
    '',
    now(),
    '{}'::jsonb,
    '{}'::jsonb,
    now(),
    now()
  ),
  (
    '30000000-0000-0000-0000-000000000003',
    'authenticated',
    'authenticated',
    'bob@gsdecorating.com',
    '',
    now(),
    '{}'::jsonb,
    '{}'::jsonb,
    now(),
    now()
  );

select set_config(
  'request.jwt.claims',
  '{"sub":"30000000-0000-0000-0000-000000000001","email":"outside@example.com"}',
  true
);
set local role authenticated;
select is(
  (select count(*) from public.opportunity_inbox_cursors),
  0::bigint,
  'an authenticated outsider cannot read checkpoint rows'
);
select throws_ok(
  $$
    insert into public.opportunity_inbox_cursors (
      user_id,
      last_checkpoint_at,
      updated_at
    )
    values (
      '30000000-0000-0000-0000-000000000001',
      now(),
      now()
    )
  $$,
  '42501',
  'new row violates row-level security policy for table "opportunity_inbox_cursors"',
  'an authenticated outsider cannot create a checkpoint'
);
reset role;

select set_config(
  'request.jwt.claims',
  '{"sub":"30000000-0000-0000-0000-000000000002","email":"alice@gsdecorating.com"}',
  true
);
set local role authenticated;
select lives_ok(
  $$
    insert into public.opportunity_inbox_cursors (
      user_id,
      last_checkpoint_at,
      created_at,
      updated_at
    )
    values (
      '30000000-0000-0000-0000-000000000003',
      '2099-01-01T00:00:00Z',
      '2099-01-01T00:00:00Z',
      '2099-01-01T00:00:00Z'
    )
  $$,
  'a GSD user can create their checkpoint even when spoofed values are supplied'
);
reset role;

select ok(
  exists (
    select 1
    from public.opportunity_inbox_cursors
    where user_id = '30000000-0000-0000-0000-000000000002'
      and last_checkpoint_at = updated_at
      and created_at = updated_at
      and last_checkpoint_at < '2099-01-01T00:00:00Z'
  ),
  'the checkpoint trigger replaces spoofed owner and client time with server evidence'
);

select set_config(
  'request.jwt.claims',
  '{"sub":"30000000-0000-0000-0000-000000000003","email":"bob@gsdecorating.com"}',
  true
);
set local role authenticated;
select is(
  (select count(*) from public.opportunity_inbox_cursors),
  0::bigint,
  'one GSD user cannot read another user''s checkpoint'
);
reset role;

select set_config(
  'request.jwt.claims',
  '{"sub":"30000000-0000-0000-0000-000000000002","email":"alice@gsdecorating.com"}',
  true
);
set local role authenticated;
select lives_ok(
  $$
    insert into public.lead_tracking (
      project_id,
      stage,
      triage_status,
      reviewed_at,
      contacted_at,
      contacted_source,
      triage_updated_by,
      updated_by,
      updated_at
    )
    values (
      'pgtap-opportunity',
      'new',
      'ready',
      '2099-01-01T00:00:00Z',
      '2099-01-01T00:00:00Z',
      'pipeline_stage',
      '30000000-0000-0000-0000-000000000003',
      '30000000-0000-0000-0000-000000000002',
      '2099-01-01T00:00:00Z'
    )
  $$,
  'a GSD user can record an Opportunity decision'
);
reset role;

select ok(
  exists (
    select 1
    from public.lead_tracking
    where project_id = 'pgtap-opportunity'
      and triage_updated_by = '30000000-0000-0000-0000-000000000002'
      and reviewed_at < '2099-01-01T00:00:00Z'
      and contacted_at < '2099-01-01T00:00:00Z'
      and updated_at < '2099-01-01T00:00:00Z'
  ),
  'the triage trigger replaces spoofed actor and future timestamps'
);

select ok(
  exists (
    select 1
    from public.opportunity_triage_events
    where project_id = 'pgtap-opportunity'
      and event_type = 'created'
      and actor_id = '30000000-0000-0000-0000-000000000002'
      and current_decision ->> 'contacted_source' = 'pipeline_stage'
  ),
  'the append-only audit captures decision actor and contact provenance'
);

select set_config(
  'request.jwt.claims',
  '{"sub":"30000000-0000-0000-0000-000000000002","email":"alice@gsdecorating.com"}',
  true
);
set local role authenticated;
select lives_ok(
  $$
    insert into public.lead_tracking (
      project_id,
      contacted_at,
      contacted_source,
      updated_by
    )
    values (
      'pgtap-manual-opportunity',
      '2026-01-15T00:00:00Z',
      'manual_history',
      '30000000-0000-0000-0000-000000000002'
    )
  $$,
  'a GSD user can record a valid past historical contact date'
);
select throws_ok(
  $$
    insert into public.lead_tracking (
      project_id,
      contacted_at,
      contacted_source,
      updated_by
    )
    values (
      'pgtap-future-manual-opportunity',
      '2099-01-15T00:00:00Z',
      'manual_history',
      '30000000-0000-0000-0000-000000000002'
    )
  $$,
  '22007',
  'Historical contact date cannot be in the future',
  'a future manual historical contact date is rejected'
);
reset role;

select is(
  (
    select contacted_at
    from public.lead_tracking
    where project_id = 'pgtap-manual-opportunity'
  ),
  '2026-01-15T00:00:00Z'::timestamptz,
  'the server preserves historical occurrence time while auditing record time separately'
);

select set_config(
  'request.jwt.claims',
  '{"sub":"30000000-0000-0000-0000-000000000002","email":"alice@gsdecorating.com"}',
  true
);
set local role authenticated;
select lives_ok(
  $$
    update public.lead_tracking
    set
      next_action = 'Call estimator',
      updated_by = '30000000-0000-0000-0000-000000000002',
      updated_at = now()
    where project_id = 'pgtap-opportunity'
  $$,
  'a non-triage lead update remains available'
);
reset role;

select is(
  (
    select triage_updated_by
    from public.lead_tracking
    where project_id = 'pgtap-opportunity'
  ),
  '30000000-0000-0000-0000-000000000002'::uuid,
  'a non-triage update preserves the prior triage actor'
);

select is(
  (
    select count(*)
    from public.opportunity_triage_events
    where project_id = 'pgtap-opportunity'
  ),
  1::bigint,
  'a non-triage update does not create a false decision audit event'
);

select * from finish();
rollback;
