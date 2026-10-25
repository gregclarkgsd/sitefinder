begin;

create extension if not exists pgtap with schema extensions;

select plan(36);

-- Fixtures: tenants A and B; a member and a viewer of A, a member of B, a
-- member of both, and a signed-in user with no membership.
insert into auth.users (id, email) values
  ('60000000-0000-0000-0000-0000000000a1', 'member@a.test'),
  ('60000000-0000-0000-0000-0000000000a2', 'viewer@a.test'),
  ('60000000-0000-0000-0000-0000000000b1', 'member@b.test'),
  ('60000000-0000-0000-0000-0000000000ab', 'both@ab.test'),
  ('60000000-0000-0000-0000-000000000000', 'nobody@none.test');

insert into public.tenants (id, name, slug) values
  ('70000000-0000-0000-0000-00000000000a', 'Tenant A', 'scope-a'),
  ('70000000-0000-0000-0000-00000000000b', 'Tenant B', 'scope-b');

insert into public.tenant_members (tenant_id, user_id, role) values
  ('70000000-0000-0000-0000-00000000000a', '60000000-0000-0000-0000-0000000000a1', 'member'),
  ('70000000-0000-0000-0000-00000000000a', '60000000-0000-0000-0000-0000000000a2', 'viewer'),
  ('70000000-0000-0000-0000-00000000000b', '60000000-0000-0000-0000-0000000000b1', 'member'),
  ('70000000-0000-0000-0000-00000000000a', '60000000-0000-0000-0000-0000000000ab', 'member'),
  ('70000000-0000-0000-0000-00000000000b', '60000000-0000-0000-0000-0000000000ab', 'member');

insert into public.ccs_projects (project_id, project_name, payload_hash, discovered_after_baseline) values
  ('scope-shared', 'Shared Site', 'h1', false),
  ('scope-other', 'Other Site', 'h2', false);

insert into public.outreach_leads (id, tenant_id, project_id, project_name, recipient_email, status) values
  ('80000000-0000-0000-0000-00000000000a', '70000000-0000-0000-0000-00000000000a', 'scope-shared', 'Shared Site', 'only-a@buyer.test', 'queued'),
  ('80000000-0000-0000-0000-00000000000b', '70000000-0000-0000-0000-00000000000b', 'scope-shared', 'Shared Site', 'only-b@buyer.test', 'queued');

insert into public.saved_projects (tenant_id, project_id, project_name, saved_by) values
  ('70000000-0000-0000-0000-00000000000a', 'scope-shared', 'Shared Site', '60000000-0000-0000-0000-0000000000a1'),
  ('70000000-0000-0000-0000-00000000000b', 'scope-shared', 'Shared Site', '60000000-0000-0000-0000-0000000000b1');

insert into public.research_runs (id, tenant_id, name, company_limit) values
  ('90000000-0000-0000-0000-00000000000a', '70000000-0000-0000-0000-00000000000a', 'Run A', 1),
  ('90000000-0000-0000-0000-00000000000b', '70000000-0000-0000-0000-00000000000b', 'Run B', 1);

-- Schema-level guarantees.
select is(
  (select count(*) from pg_policies
   where schemaname = 'public' and (coalesce(qual, '') || coalesce(with_check, '')) like '%@%'),
  0::bigint,
  'no policy gates access on an email domain'
);
select is(
  (select count(*) from information_schema.columns
   where table_schema = 'public' and column_name = 'tenant_id' and is_nullable = 'NO'
     and column_default is null
     and table_name in (
       'saved_projects', 'project_notes', 'project_tasks', 'lead_tracking',
       'outreach_leads', 'outreach_communications', 'outreach_suppressions',
       'outreach_mailbox_state', 'outreach_oauth_states', 'outreach_reply_outcomes',
       'research_runs', 'research_tasks', 'research_events', 'research_candidates',
       'attio_sync_links')),
  15::bigint,
  'every tenant-owned table has tenant_id NOT NULL with no default'
);
select is(
  (select count(*) from public.saved_projects where project_id = 'scope-shared'),
  2::bigint,
  'two tenants can save the same shared project'
);
select lives_ok(
  $$ insert into public.outreach_suppressions (tenant_id, email, reason, source) values
       ('70000000-0000-0000-0000-00000000000a', 'dup@buyer.test', 'test', 'manual'),
       ('70000000-0000-0000-0000-00000000000b', 'dup@buyer.test', 'test', 'manual') $$,
  'two tenants can suppress the same address independently'
);
select throws_ok(
  $$ insert into public.outreach_leads (project_id, project_name, status)
     values ('scope-other', 'Other Site', 'queued') $$,
  '23502', null,
  'a lead with no tenant and no acting user is rejected'
);

-- Member of A.
select set_config('request.jwt.claims', '{"sub":"60000000-0000-0000-0000-0000000000a1","role":"authenticated"}', true);
set local role authenticated;
select is((select count(*) from public.saved_projects), 1::bigint, 'member of A sees only A''s saved projects');
select is((select count(*) from public.outreach_leads), 1::bigint, 'member of A sees only A''s outreach leads');
select is((select count(*) from public.outreach_suppressions), 1::bigint, 'member of A sees only A''s suppressions');
select is((select count(*) from public.research_runs), 1::bigint, 'member of A sees only A''s research runs');
select is((select count(*) from public.ccs_projects where project_id like 'scope-%'), 2::bigint, 'tenant members read shared CCS projects');
select lives_ok(
  $$ insert into public.saved_projects (project_id, project_name, saved_by)
     values ('scope-other', 'Other Site', '60000000-0000-0000-0000-0000000000a1') $$,
  'a single-tenant member can save without naming the tenant'
);
select throws_ok(
  $$ insert into public.saved_projects (tenant_id, project_id, project_name, saved_by)
     values ('70000000-0000-0000-0000-00000000000b', 'scope-other', 'Other Site', '60000000-0000-0000-0000-0000000000a1') $$,
  '42501', null,
  'member of A cannot write into B'
);
update public.outreach_leads set status = 'skipped', updated_by = '60000000-0000-0000-0000-0000000000a1'
where id = '80000000-0000-0000-0000-00000000000b';
select throws_ok(
  $$ update public.outreach_leads set tenant_id = '70000000-0000-0000-0000-00000000000b',
       updated_by = '60000000-0000-0000-0000-0000000000a1'
     where id = '80000000-0000-0000-0000-00000000000a' $$,
  '23514', null,
  'a row cannot be moved to another tenant'
);
select throws_ok(
  $$ insert into public.outreach_communications (tenant_id, outreach_lead_id, direction, channel, status, created_by)
     values ('70000000-0000-0000-0000-00000000000a', '80000000-0000-0000-0000-00000000000b',
             'internal', 'note', 'logged', '60000000-0000-0000-0000-0000000000a1') $$,
  '23514', null,
  'a communication cannot point at another tenant''s lead'
);
select lives_ok(
  $$ insert into public.outreach_communications (outreach_lead_id, direction, channel, status, created_by)
     values ('80000000-0000-0000-0000-00000000000a', 'internal', 'note', 'logged', '60000000-0000-0000-0000-0000000000a1') $$,
  'a communication takes its lead''s tenant'
);
select throws_ok(
  $$ insert into public.tenant_outreach_settings (tenant_id) values ('70000000-0000-0000-0000-00000000000a') $$,
  '42501', null,
  'app users cannot write outreach settings'
);
reset role;
select is(
  (select status from public.outreach_leads where id = '80000000-0000-0000-0000-00000000000b'),
  'queued', 'member of A cannot update B''s lead'
);
select is(
  (select tenant_id from public.saved_projects where project_id = 'scope-other'),
  '70000000-0000-0000-0000-00000000000a'::uuid,
  'the derived tenant is the member''s only tenant'
);

-- Viewer of A.
select set_config('request.jwt.claims', '{"sub":"60000000-0000-0000-0000-0000000000a2","role":"authenticated"}', true);
set local role authenticated;
select is((select count(*) from public.outreach_leads), 1::bigint, 'a viewer can read their tenant''s leads');
select throws_ok(
  $$ insert into public.saved_projects (tenant_id, project_id, project_name, saved_by)
     values ('70000000-0000-0000-0000-00000000000a', 'scope-other', 'Other Site', '60000000-0000-0000-0000-0000000000a2') $$,
  '42501', null,
  'a viewer cannot write'
);
reset role;

-- Member of both tenants must name the tenant.
select set_config('request.jwt.claims', '{"sub":"60000000-0000-0000-0000-0000000000ab","role":"authenticated"}', true);
set local role authenticated;
select is((select count(*) from public.outreach_leads), 2::bigint, 'a member of both tenants sees both');
select throws_ok(
  $$ insert into public.project_notes (project_id, project_name, note, updated_by)
     values ('scope-shared', 'Shared Site', 'ambiguous', '60000000-0000-0000-0000-0000000000ab') $$,
  '42501', null,
  'a multi-tenant member cannot write without naming the tenant'
);
select lives_ok(
  $$ insert into public.project_notes (tenant_id, project_id, project_name, note, updated_by)
     values ('70000000-0000-0000-0000-00000000000b', 'scope-shared', 'Shared Site', 'for B', '60000000-0000-0000-0000-0000000000ab') $$,
  'a multi-tenant member can write when naming the tenant'
);
reset role;

-- Signed in, no membership.
select set_config('request.jwt.claims', '{"sub":"60000000-0000-0000-0000-000000000000","role":"authenticated"}', true);
set local role authenticated;
select is((select count(*) from public.ccs_projects), 0::bigint, 'users with no tenant cannot read CCS history');
select is((select count(*) from public.outreach_leads), 0::bigint, 'users with no tenant cannot read outreach leads');
reset role;
select set_config('request.jwt.claims', '{}', true);

-- Server-side writers that predate tenancy.
insert into public.research_tasks (id, run_id, company_id, company_name, domain)
values ('90000000-0000-0000-0000-0000000000bb', '90000000-0000-0000-0000-00000000000b', 'c1', 'Company', 'company.test');
select is(
  (select tenant_id from public.research_tasks where id = '90000000-0000-0000-0000-0000000000bb'),
  '70000000-0000-0000-0000-00000000000b'::uuid,
  'research tasks take their run''s tenant'
);
select lives_ok(
  $$ insert into public.research_runs (id, name, company_limit)
     values ('90000000-0000-0000-0000-00000000000a', 'Run A again', 1)
     on conflict (id) do nothing $$,
  'the worker can re-upsert an existing run without naming the tenant'
);
insert into public.outreach_reply_outcomes (outreach_lead_id, project_id, provider_message_id, outcome, confidence, evidence, action_status)
values ('80000000-0000-0000-0000-00000000000a', 'scope-shared', 'scope-msg-1', 'positive', 0.9, 'yes', 'completed');
select is(
  (select tenant_id from public.outreach_reply_outcomes where provider_message_id = 'scope-msg-1'),
  '70000000-0000-0000-0000-00000000000a'::uuid,
  'reply outcomes take their lead''s tenant'
);
insert into public.outreach_suppressions (email, reason, source)
values ('only-a@buyer.test', 'Recipient requested no further contact', 'gmail-reply');
select is(
  (select tenant_id from public.outreach_suppressions where email = 'only-a@buyer.test'),
  '70000000-0000-0000-0000-00000000000a'::uuid,
  'reply suppressions take the tenant of the lead they came from'
);
select throws_ok(
  $$ insert into public.outreach_suppressions (email, reason, source)
     values ('stranger@buyer.test', 'test', 'gmail-reply') $$,
  '23502', null,
  'a suppression with no lead or acting user is rejected'
);
insert into public.outreach_mailbox_state (mailbox_email, connected_by)
values ('sender@a.test', '60000000-0000-0000-0000-0000000000a1');
select is(
  (select tenant_id from public.outreach_mailbox_state where mailbox_email = 'sender@a.test'),
  '70000000-0000-0000-0000-00000000000a'::uuid,
  'a connected mailbox takes the tenant of the user who connected it'
);

-- CCS auto-queue and Attio project sync follow per-tenant settings.
select throws_ok(
  $$ insert into public.tenant_outreach_settings (tenant_id, auto_queue_new_ccs_projects)
     values ('70000000-0000-0000-0000-00000000000b', true) $$,
  '23514', null,
  'auto-queue cannot be enabled without templates'
);
insert into public.tenant_outreach_settings (
  tenant_id, auto_queue_new_ccs_projects, auto_queue_subject_template, auto_queue_body_template, attio_project_sync_enabled
) values (
  '70000000-0000-0000-0000-00000000000a', true, 'Is {{project_name}} live?', 'Hi {{first_name}}, about {{project_name}}.', true
);
insert into public.ccs_projects (project_id, project_name, payload_hash, discovered_after_baseline, site_manager_name, marker_email)
values ('scope-new', 'New Site', 'h3', true, 'Jo Bloggs', 'jo@builder.test');
select is(
  (select count(*) || ':' || min(tenant_id::text) from public.outreach_leads where project_id = 'scope-new'),
  '1:70000000-0000-0000-0000-00000000000a',
  'a new CCS project is queued only for tenants that opted in'
);
select is(
  (select email_subject || ' / ' || email_body from public.outreach_leads where project_id = 'scope-new'),
  'Is New Site live? / Hi Jo, about New Site.',
  'the queued lead uses the tenant''s own templates'
);
insert into public.attio_sync_links (entity_type, source_key, attio_object_slug, sync_status)
values ('project', 'scope-new', 'projects', 'synced');
select is(
  (select tenant_id from public.attio_sync_links where source_key = 'scope-new'),
  '70000000-0000-0000-0000-00000000000a'::uuid,
  'Attio links take the tenant that owns the project sync'
);
select throws_ok(
  $$ insert into public.tenant_outreach_settings (tenant_id, attio_project_sync_enabled)
     values ('70000000-0000-0000-0000-00000000000b', true) $$,
  '23505', null,
  'only one tenant can own the Attio project sync'
);

select * from finish();
rollback;
