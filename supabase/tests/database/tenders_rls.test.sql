begin;

create extension if not exists pgtap with schema extensions;

select plan(22);

-- Access: shared public notices are readable when signed in, written only by
-- the service role.
select ok((select relrowsecurity from pg_class where oid = 'public.tender_notices'::regclass), 'tender_notices has RLS enabled');
select ok((select relrowsecurity from pg_class where oid = 'public.tender_notice_releases'::regclass), 'tender_notice_releases has RLS enabled');
select ok((select relrowsecurity from pg_class where oid = 'public.tender_pull_runs'::regclass), 'tender_pull_runs has RLS enabled');
select ok((select relrowsecurity from pg_class where oid = 'public.tender_sources'::regclass), 'tender_sources has RLS enabled');
select ok(
  not has_table_privilege('anon', 'public.tender_notices', 'select')
  and not has_table_privilege('anon', 'public.tender_notice_releases', 'select')
  and not has_table_privilege('anon', 'public.tender_pull_runs', 'select')
  and not has_table_privilege('anon', 'public.tender_sources', 'select'),
  'anon cannot read any tender table'
);
select ok(
  not has_table_privilege('authenticated', 'public.tender_notices', 'insert, update, delete')
  and not has_table_privilege('authenticated', 'public.tender_notice_releases', 'insert, update, delete')
  and not has_table_privilege('authenticated', 'public.tender_pull_runs', 'insert, update, delete')
  and not has_table_privilege('authenticated', 'public.tender_sources', 'insert, update, delete'),
  'authenticated cannot write any tender table'
);
select ok(
  not has_function_privilege('anon', 'public.ingest_tender_notices(jsonb)', 'execute')
  and not has_function_privilege('authenticated', 'public.ingest_tender_notices(jsonb)', 'execute')
  and has_function_privilege('service_role', 'public.ingest_tender_notices(jsonb)', 'execute'),
  'only the service role can ingest notices'
);

-- Dedupe: the same ocid from both feeds is stored once.
select is(
  public.ingest_tender_notices($$[
    {"ocid":"ocds-test-1","source":"fts","release_id":"fts-r1","stage":"tender","title":"Older FTS title",
     "cpv_codes":["45442100","45000000"],"regions":["UKI"],"source_updated_at":"2026-10-01T09:00:00Z","raw":{"id":"fts-r1"}},
    {"ocid":"ocds-test-1","source":"cf","release_id":"cf-r1","stage":"tender","title":"Newer CF title",
     "cpv_codes":["45442100"],"source_updated_at":"2026-10-02T09:00:00Z","raw":{"id":"cf-r1"}}
  ]$$::jsonb) - 'touched_ocids',
  '{"received":2,"inserted":1,"updated":0,"releases_added":2}'::jsonb,
  'a notice in both feeds is inserted once with both releases'
);
select is((select count(*) from public.tender_notices where ocid = 'ocds-test-1'), 1::bigint, 'one notice row per ocid');
select is((select count(*) from public.tender_notice_releases where ocid = 'ocds-test-1'), 2::bigint, 'two release rows for the ocid');
select is(
  (select source || ':' || title from public.tender_notices where ocid = 'ocds-test-1'),
  'cf:Newer CF title',
  'the notice holds the newest release'
);
select is(
  (select cpv_codes from public.tender_notices where ocid = 'ocds-test-1'),
  array['45442100'],
  'array fields are stored as text arrays'
);

select is(
  public.ingest_tender_notices($$[
    {"ocid":"ocds-test-1","source":"fts","release_id":"fts-r1","title":"Older FTS title",
     "source_updated_at":"2026-10-01T09:00:00Z","raw":{"id":"fts-r1"}},
    {"ocid":"ocds-test-1","source":"cf","release_id":"cf-r1","title":"Newer CF title",
     "source_updated_at":"2026-10-02T09:00:00Z","raw":{"id":"cf-r1"}}
  ]$$::jsonb),
  '{"received":2,"inserted":0,"updated":0,"releases_added":0,"touched_ocids":[]}'::jsonb,
  're-running the same window changes nothing'
);

select is(
  (public.ingest_tender_notices($$[
    {"ocid":"ocds-test-1","source":"fts","release_id":"fts-r0","title":"Stale amendment",
     "source_updated_at":"2026-09-01T09:00:00Z","raw":{"id":"fts-r0"}}
  ]$$::jsonb) ->> 'updated')::int,
  0,
  'an older release does not overwrite a newer one'
);
select is(
  (select title from public.tender_notices where ocid = 'ocds-test-1'),
  'Newer CF title',
  'the newer content is kept'
);
select is((select count(*) from public.tender_notice_releases where ocid = 'ocds-test-1'), 3::bigint, 'the older release id is still recorded');

select is(
  public.ingest_tender_notices($$[
    {"ocid":"ocds-test-1","source":"fts","release_id":"fts-r2","stage":"award","title":"Awarded",
     "source_updated_at":"2026-10-05T09:00:00Z","raw":{"id":"fts-r2"}}
  ]$$::jsonb) -> 'touched_ocids',
  '["ocds-test-1"]'::jsonb,
  'a newer release updates the notice and reports it for re-scoring'
);

select throws_ok(
  $$ select public.ingest_tender_notices('[{"source":"fts","release_id":"x","raw":{}}]'::jsonb) $$,
  '23502', null,
  'a notice without an ocid is rejected'
);
select throws_ok(
  $$ select public.ingest_tender_notices('{"ocid":"x"}'::jsonb) $$,
  '22023', null,
  'the batch must be an array'
);

-- Pull runs record honest outcomes.
select throws_ok(
  $$ insert into public.tender_pull_runs (source, status, finished_at) values ('fts', 'unknown', now()) $$,
  '23514', null,
  'pull run status is limited to known outcomes'
);
select throws_ok(
  $$ insert into public.tender_pull_runs (source, status) values ('cf', 'failed') $$,
  '23514', null,
  'a finished pull run needs a finish time'
);

-- Signed-in users can read notices.
insert into auth.users (id, email) values ('a1000000-0000-0000-0000-000000000001', 'reader@tenders.test');
select set_config('request.jwt.claims', '{"sub":"a1000000-0000-0000-0000-000000000001","role":"authenticated"}', true);
set local role authenticated;
select is((select count(*) from public.tender_notices where ocid = 'ocds-test-1'), 1::bigint, 'signed-in users can read tender notices');
reset role;

select * from finish();
rollback;
