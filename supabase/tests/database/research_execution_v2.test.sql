begin;

create extension if not exists pgtap with schema extensions;

select plan(25);

insert into auth.users (id, email, created_at, updated_at)
values (
  '30000000-0000-0000-0000-000000000001',
  'research-v2@gsdecorating.com',
  now(),
  now()
);

create function pg_temp.research_attestation_v2(marker text)
returns jsonb
language sql
volatile
as $$
  select jsonb_build_object(
    'schemaVersion', 2,
    'cleanup', jsonb_build_object(
      'ledgerSha256', repeat(marker, 64),
      'manifestSha256', repeat('b', 64),
      'approvedAt', now()
    ),
    'attio', jsonb_build_object(
      'peopleSha256', repeat('c', 64),
      'manifestSha256', repeat('d', 64),
      'completedAt', now(),
      'peopleCount', 10
    ),
    'pipedrive', jsonb_build_object(
      'peopleSha256', repeat('e', 64),
      'manifestSha256', repeat('f', 64),
      'completedAt', now(),
      'peopleCount', 10
    )
  );
$$;

create function pg_temp.research_manifest_v2(
  requested_claim_id uuid,
  stale boolean default false
)
returns text
language sql
stable
as $$
  with claim as (
    select stored_claim.*
    from public.research_run_claims stored_claim
    where stored_claim.id = requested_claim_id
  ),
  facts as (
    select
      claim.*,
      (
        select private.research_sha256_v2(
          coalesce(
            string_agg(
              concat_ws(
                ':',
                task.id::text,
                task.status,
                task.progress::text,
                task.page_count::text,
                task.contacts_found::text
              ),
              E'\n'
              order by task.id
            ),
            ''
          )
        )
        from public.research_tasks task
        where task.run_id = claim.run_id
          and task.claim_id = claim.id
      ) as task_set_hash,
      (
        select private.research_sha256_v2(
          coalesce(
            string_agg(
              concat_ws(
                ':',
                candidate.id::text,
                revision.id::text,
                revision.content_hash
              ),
              E'\n'
              order by candidate.id
            ),
            ''
          )
        )
        from public.research_candidates candidate
        join public.research_candidate_revisions revision
          on revision.id = candidate.current_revision_id
        where candidate.run_id = claim.run_id
          and candidate.is_active
          and revision.claim_id = claim.id
      ) as candidate_set_hash
    from claim
  )
  select jsonb_build_object(
    'schemaVersion', 2,
    'kind', 'research_execution_completion',
    'runId', facts.run_id,
    'claimId', facts.id,
    'candidateSetSha256', case
      when stale then repeat('0', 64)
      else facts.candidate_set_hash
    end,
    'taskSetSha256', facts.task_set_hash,
    'counts', jsonb_build_object(
      'companiesChecked', 1,
      'pagesInspected', 3,
      'peopleFound', 1
    ),
    'inputs', jsonb_build_object(
      'cleanupLedgerSha256', facts.cleanup_ledger_sha256,
      'cleanupManifestSha256', facts.cleanup_manifest_sha256,
      'attioPeopleSha256', facts.attio_people_sha256,
      'attioManifestSha256', facts.attio_manifest_sha256,
      'pipedrivePeopleSha256', facts.pipedrive_people_sha256,
      'pipedriveManifestSha256', facts.pipedrive_manifest_sha256,
      'suppressionSetSha256', facts.suppression_set_sha256
    )
  )::text
  from facts;
$$;

select ok(
  (
    select bool_and(relrowsecurity)
    from pg_class
    where oid in (
      'public.research_run_claims'::regclass,
      'public.research_candidate_revisions'::regclass,
      'public.research_evidence_revisions'::regclass,
      'public.research_run_completions'::regclass,
      'public.research_candidate_decisions'::regclass,
      'public.research_contact_handoffs'::regclass
    )
  ),
  'all protocol-v2 public tables have RLS'
);
select ok(
  not has_table_privilege('anon', 'public.research_run_claims', 'select')
  and not has_table_privilege(
    'authenticated',
    'public.research_run_claims',
    'select'
  )
  and not has_table_privilege(
    'authenticated',
    'public.research_contact_handoffs',
    'select'
  )
  and not has_table_privilege(
    'authenticated',
    'private.research_contact_point_values',
    'select'
  ),
  'browser roles cannot inspect claim, handoff, or clear-value secrets'
);
select ok(
  has_table_privilege(
    'authenticated',
    'public.research_candidate_revisions',
    'select'
  )
  and not has_table_privilege(
    'authenticated',
    'public.research_candidate_revisions',
    'insert, update, delete'
  )
  and has_table_privilege(
    'authenticated',
    'public.research_candidate_decisions',
    'select'
  )
  and not has_table_privilege(
    'authenticated',
    'public.research_candidate_decisions',
    'insert, update, delete'
  ),
  'safe evidence and decision read models are read-only'
);
select ok(
  not has_function_privilege(
    'authenticated',
    'public.claim_research_run_v2(uuid,text,text[],text,jsonb,integer)',
    'execute'
  ),
  'authenticated clients cannot execute worker RPCs'
);
select ok(
  has_function_privilege(
    'service_role',
    'public.claim_research_run_v2(uuid,text,text[],text,jsonb,integer)',
    'execute'
  )
  and has_function_privilege(
    'service_role',
    'public.complete_research_run_v2(uuid,text,text,text)',
    'execute'
  ),
  'the service role can execute the bounded worker RPCs'
);

-- Lease race, idempotency, wrong-token rejection, reclaim, and dead-letter.
insert into public.research_runs (
  id, name, source, status, company_limit, configuration,
  execution_protocol, max_attempts
)
values (
  '31000000-0000-0000-0000-000000000001',
  'Lease fixture',
  'file',
  'queued',
  1,
  '{"requestedSources":["website"],"requestVersion":2}',
  2,
  2
);
insert into public.research_tasks (
  id, run_id, company_id, company_name, domain
)
values (
  '31000000-0000-0000-0000-000000000002',
  '31000000-0000-0000-0000-000000000001',
  'lease-company',
  'Lease Company',
  'lease.example'
);

set local role service_role;
select is(
  public.claim_research_run_v2(
    '31000000-0000-0000-0000-000000000010',
    'lease-worker-a',
    array['website'],
    'lease-token-a-0000000000000000000000000000',
    pg_temp.research_attestation_v2('a'),
    120
  ) ->> 'claimed',
  'true',
  'first worker claims the queued run'
);
select is(
  public.claim_research_run_v2(
    '31000000-0000-0000-0000-000000000010',
    'lease-worker-a',
    array['website'],
    'lease-token-a-0000000000000000000000000000',
    pg_temp.research_attestation_v2('a'),
    120
  ) ->> 'idempotent',
  'true',
  'retrying the same claim request returns the same live claim'
);
select is(
  public.claim_research_run_v2(
    '31000000-0000-0000-0000-000000000011',
    'lease-worker-b',
    array['website'],
    'lease-token-b-0000000000000000000000000000',
    pg_temp.research_attestation_v2('a'),
    120
  ) ->> 'claimed',
  'false',
  'a competing worker cannot claim live work'
);
select throws_ok(
  format(
    $sql$
      select public.heartbeat_research_claim_v2(
        %L::uuid,
        'wrong-token-000000000000000000000000000000',
        120
      )
    $sql$,
    (
      select id from public.research_run_claims
      where claim_request_id =
        '31000000-0000-0000-0000-000000000010'
    )
  ),
  '28000',
  'research_claim_not_active',
  'a wrong bearer token cannot extend a lease'
);
reset role;
select ok(
  (
    select token_sha256 =
      private.research_sha256_v2(
        'lease-token-a-0000000000000000000000000000'
      )
      and token_sha256 <>
        'lease-token-a-0000000000000000000000000000'
    from public.research_run_claims
    where claim_request_id =
      '31000000-0000-0000-0000-000000000010'
  ),
  'only the one-way bearer-token verifier is stored'
);

update public.research_run_claims
set
  lease_started_at = now() - interval '4 minutes',
  heartbeat_at = now() - interval '3 minutes',
  lease_expires_at = now() - interval '2 minutes',
  absolute_expires_at = now() - interval '1 minute'
where claim_request_id =
  '31000000-0000-0000-0000-000000000010';
set local role service_role;
select is(
  public.reclaim_expired_research_claims_v2(10),
  1,
  'one expired lease is reclaimed'
);
reset role;
select is(
  (
    select status || ':' || attempt_count
    from public.research_runs
    where id = '31000000-0000-0000-0000-000000000001'
  ),
  'queued:1',
  'reclaim preserves the attempt ledger and safely requeues work'
);
set local role service_role;
select is(
  public.claim_research_run_v2(
    '31000000-0000-0000-0000-000000000012',
    'lease-worker-c',
    array['website'],
    'lease-token-c-0000000000000000000000000000',
    pg_temp.research_attestation_v2('a'),
    120
  ) ->> 'attemptNo',
  '2',
  'reclaimed work receives a distinct second attempt'
);
reset role;
update public.research_run_claims
set
  lease_started_at = now() - interval '4 minutes',
  heartbeat_at = now() - interval '3 minutes',
  lease_expires_at = now() - interval '2 minutes',
  absolute_expires_at = now() - interval '1 minute'
where claim_request_id =
  '31000000-0000-0000-0000-000000000012';
set local role service_role;
select is(
  public.reclaim_expired_research_claims_v2(10),
  1,
  'the final expired attempt is durably reclaimed'
);
reset role;
select is(
  (
    select status
    from public.research_runs
    where id = '31000000-0000-0000-0000-000000000001'
  ),
  'dead_lettered',
  'exhausted work enters the dead-letter state'
);

insert into public.research_runs (id, name, company_limit)
values (
  '32000000-0000-0000-0000-000000000001',
  'Cross-run fixture',
  1
);
insert into public.research_tasks (
  id, run_id, company_id, company_name, domain
)
values (
  '32000000-0000-0000-0000-000000000002',
  '32000000-0000-0000-0000-000000000001',
  'other-company',
  'Other Company',
  'other.example'
);
select throws_ok(
  $$
    insert into public.research_events (
      run_id, task_id, sequence, event_type, message
    )
    values (
      '31000000-0000-0000-0000-000000000001',
      '32000000-0000-0000-0000-000000000002',
      10,
      'run',
      'must not cross runs'
    )
  $$,
  '23503',
  null,
  'composite integrity rejects a cross-run task reference'
);

-- Verified path through immutable revisions and an exact completion manifest.
insert into public.research_runs (
  id, name, source, status, company_limit, configuration,
  execution_protocol, max_attempts
)
values (
  '33000000-0000-0000-0000-000000000001',
  'Verified fixture',
  'file',
  'queued',
  1,
  '{"requestedSources":["website"],"requestVersion":2}',
  2,
  3
);
insert into public.research_tasks (
  id, run_id, company_id, company_name, domain
)
values (
  '33000000-0000-0000-0000-000000000002',
  '33000000-0000-0000-0000-000000000001',
  'verified-company',
  'Verified Company',
  'verified.example'
);
set local role service_role;
select public.claim_research_run_v2(
  '33000000-0000-0000-0000-000000000010',
  'verified-worker',
  array['website'],
  'verified-run-token-000000000000000000000000',
  pg_temp.research_attestation_v2('1'),
  300
);
reset role;

select lives_ok(
  format(
    $sql$
      do $body$
      declare
        selected_claim uuid := %L::uuid;
      begin
        perform public.transition_research_task_v2(
          selected_claim,
          'verified-run-token-000000000000000000000000',
          '33000000-0000-0000-0000-000000000002',
          'running', 10, 0, 0
        );
        perform public.append_research_candidate_revision_v2(
          selected_claim,
          'verified-run-token-000000000000000000000000',
          '33000000-0000-0000-0000-000000000002',
          'verified-person',
          %L::jsonb
        );
        perform public.transition_research_task_v2(
          selected_claim,
          'verified-run-token-000000000000000000000000',
          '33000000-0000-0000-0000-000000000002',
          'completed', 100, 3, 1
        );
      end
      $body$
    $sql$,
    (
      select id from public.research_run_claims
      where claim_request_id =
        '33000000-0000-0000-0000-000000000010'
    ),
    jsonb_build_object(
      'name', 'Verified Person',
      'jobTitle', 'Commercial Manager',
      'roleCategory', 'commercial',
      'sourceKind', 'official_website',
      'sourceUrl', 'https://verified.example/team',
      'evidenceExcerpt', 'Public company team page.',
      'crmComparison', 'missing_from_both',
      'emailStatus', 'public_email_found',
      'confidence', 0.900,
      'observedAt', now(),
      'contactCommitments', jsonb_build_array(
        jsonb_build_object(
          'contactPointId', 'public-email-1',
          'kind', 'email',
          'status', 'public',
          'domain', 'verified.example',
          'commitmentSha256',
            private.research_sha256_v2(
              '0123456789abcdef' || E'\x1f' ||
              'person@verified.example'
            )
        )
      )
    )::text
  ),
  'claim-scoped task and candidate transitions commit atomically'
);
select throws_ok(
  $$
    update public.research_candidate_revisions
    set name = 'Mutated Person'
    where candidate_id = (
      select id from public.research_candidates
      where external_candidate_id = 'verified-person'
    )
  $$,
  '55000',
  'research_integrity_v2_append_only',
  'candidate and evidence history is immutable'
);
select throws_ok(
  format(
    $sql$
      select public.complete_research_run_v2(
        %L::uuid,
        'verified-run-token-000000000000000000000000',
        %L,
        %L
      )
    $sql$,
    (
      select id from public.research_run_claims
      where claim_request_id =
        '33000000-0000-0000-0000-000000000010'
    ),
    pg_temp.research_manifest_v2(
      (
        select id from public.research_run_claims
        where claim_request_id =
          '33000000-0000-0000-0000-000000000010'
      ),
      true
    ),
    private.research_sha256_v2(
      pg_temp.research_manifest_v2(
        (
          select id from public.research_run_claims
          where claim_request_id =
            '33000000-0000-0000-0000-000000000010'
        ),
        true
      )
    )
  ),
  '55000',
  'research_completion_manifest_state_mismatch',
  'a stale candidate-set manifest cannot complete the run'
);
insert into public.outreach_suppressions (email, reason, source)
values (
  'changed-suppression@example.com',
  'pgTAP change',
  'pgtap'
);
select throws_ok(
  format(
    $sql$
      select public.complete_research_run_v2(
        %L::uuid,
        'verified-run-token-000000000000000000000000',
        %L,
        %L
      )
    $sql$,
    (
      select id from public.research_run_claims
      where claim_request_id =
        '33000000-0000-0000-0000-000000000010'
    ),
    pg_temp.research_manifest_v2(
      (
        select id from public.research_run_claims
        where claim_request_id =
          '33000000-0000-0000-0000-000000000010'
      )
    ),
    private.research_sha256_v2(
      pg_temp.research_manifest_v2(
        (
          select id from public.research_run_claims
          where claim_request_id =
            '33000000-0000-0000-0000-000000000010'
        )
      )
    )
  ),
  '55000',
  'research_completion_freshness_or_shape_denied',
  'a changed live suppression set prevents completion'
);
delete from public.outreach_suppressions
where email = 'changed-suppression@example.com';

select lives_ok(
  format(
    $sql$
      select public.complete_research_run_v2(
        %L::uuid,
        'verified-run-token-000000000000000000000000',
        %L,
        %L
      )
    $sql$,
    (
      select id from public.research_run_claims
      where claim_request_id =
        '33000000-0000-0000-0000-000000000010'
    ),
    pg_temp.research_manifest_v2(
      (
        select id from public.research_run_claims
        where claim_request_id =
          '33000000-0000-0000-0000-000000000010'
      )
    ),
    private.research_sha256_v2(
      pg_temp.research_manifest_v2(
        (
          select id from public.research_run_claims
          where claim_request_id =
            '33000000-0000-0000-0000-000000000010'
        )
      )
    )
  ),
  'an exact fresh manifest atomically completes the run'
);

update public.research_run_claims
set input_expires_at = now() - interval '1 second'
where claim_request_id =
  '33000000-0000-0000-0000-000000000010';
select throws_ok(
  format(
    $sql$
      select public.decide_research_candidate_v2(
        %L::uuid, %L::uuid, %L, 'approved',
        'stale-input test',
        '30000000-0000-0000-0000-000000000001'
      )
    $sql$,
    (
      select id from public.research_candidates
      where external_candidate_id = 'verified-person'
    ),
    (
      select current_revision_id from public.research_candidates
      where external_candidate_id = 'verified-person'
    ),
    (
      select current_content_hash from public.research_candidates
      where external_candidate_id = 'verified-person'
    )
  ),
  '55000',
  'research_decision_freshness_or_suppression_denied',
  'human approval is denied after its input snapshot expires'
);
update public.research_run_claims
set input_expires_at = now() + interval '1 hour'
where claim_request_id =
  '33000000-0000-0000-0000-000000000010';

select lives_ok(
  format(
    $sql$
      select public.decide_research_candidate_v2(
        %L::uuid, %L::uuid, %L, 'approved',
        'evidence reviewed',
        '30000000-0000-0000-0000-000000000001'
      )
    $sql$,
    (
      select id from public.research_candidates
      where external_candidate_id = 'verified-person'
    ),
    (
      select current_revision_id from public.research_candidates
      where external_candidate_id = 'verified-person'
    ),
    (
      select current_content_hash from public.research_candidates
      where external_candidate_id = 'verified-person'
    )
  ),
  'fresh eligible evidence creates a decision and one handoff request'
);
select throws_ok(
  $$
    update public.research_candidate_decisions
    set reason = 'rewritten history'
    where candidate_id = (
      select id from public.research_candidates
      where external_candidate_id = 'verified-person'
    )
  $$,
  '55000',
  'research_integrity_v2_append_only',
  'a human decision cannot be rewritten'
);

select lives_ok(
  format(
    $sql$
      do $body$
      declare
        selected_handoff uuid := %L::uuid;
        denied boolean := false;
        receipt jsonb;
      begin
        perform public.claim_research_contact_handoff_v2(
          selected_handoff,
          '33000000-0000-0000-0000-000000000020',
          'handoff-worker',
          'handoff-token-000000000000000000000000000',
          120
        );
        insert into public.outreach_suppressions (email, reason, source)
        values (
          'person@verified.example',
          'pgTAP handoff suppression',
          'pgtap'
        );
        begin
          perform public.submit_research_contact_handoff_v2(
            selected_handoff,
            'handoff-token-000000000000000000000000000',
            'person@verified.example',
            '0123456789abcdef'
          );
        exception when sqlstate '55000' then
          denied := true;
        end;
        if not denied then
          raise exception 'suppressed handoff unexpectedly succeeded';
        end if;
        delete from public.outreach_suppressions
        where email = 'person@verified.example';
        receipt := public.submit_research_contact_handoff_v2(
          selected_handoff,
          'handoff-token-000000000000000000000000000',
          'person@verified.example',
          '0123456789abcdef'
        );
        if receipt ->> 'crmWritebackAuthorized' <> 'false'
          or receipt ->> 'outreachAuthorized' <> 'false'
          or not exists (
            select 1
            from private.research_contact_point_values
            where handoff_id = selected_handoff
          )
        then
          raise exception 'restricted handoff invariant failed';
        end if;
      end
      $body$
    $sql$,
    (
      select id from public.research_contact_handoffs
      where candidate_id = (
        select id from public.research_candidates
        where external_candidate_id = 'verified-person'
      )
    )
  ),
  'handoff enforces suppression and never authorises CRM or outreach'
);

select * from finish();
rollback;
