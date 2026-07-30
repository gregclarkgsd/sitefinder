-- Research execution integrity protocol v2.
--
-- This is deliberately additive. Existing application code continues to create
-- protocol-1 runs, while protocol-2 runs must use the transactional RPCs below.
-- Protocol 2 never writes to a CRM and never sends outreach.

create extension if not exists pgcrypto with schema extensions;
create schema if not exists private;

revoke all on schema private from public, anon, authenticated;

create or replace function private.research_sha256_v2(value text)
returns text
language sql
immutable
parallel safe
set search_path = ''
as $$
  select encode(
    extensions.digest(convert_to(coalesce(value, ''), 'UTF8'), 'sha256'),
    'hex'
  );
$$;

create or replace function private.research_sources_are_valid_v2(value text[])
returns boolean
language plpgsql
immutable
parallel safe
set search_path = ''
as $$
declare
  item text;
  seen text[] := array[]::text[];
begin
  if value is null
    or cardinality(value) not between 1 and 4
    or not ('website' = any(value))
  then
    return false;
  end if;

  foreach item in array value loop
    if item not in ('website', 'apollo', 'companiesHouse', 'procurement')
      or item = any(seen)
    then
      return false;
    end if;
    seen := array_append(seen, item);
  end loop;

  return true;
end;
$$;

create or replace function private.research_contact_commitments_are_valid_v2(
  value jsonb
)
returns boolean
language plpgsql
immutable
parallel safe
set search_path = ''
as $$
declare
  item jsonb;
  item_key text;
begin
  if value is null or jsonb_typeof(value) <> 'array' then
    return false;
  end if;

  for item in select element from jsonb_array_elements(value) as items(element)
  loop
    if jsonb_typeof(item) <> 'object'
      or coalesce(item ->> 'contactPointId', '') !~ '^[A-Za-z0-9._:-]{1,120}$'
      or coalesce(item ->> 'kind', '') not in ('email', 'phone')
      or coalesce(item ->> 'status', '') not in (
        'public',
        'licensed_provider',
        'inferred',
        'existing',
        'unknown'
      )
      or coalesce(item ->> 'commitmentSha256', '') !~ '^[0-9a-f]{64}$'
    then
      return false;
    end if;

    for item_key in select key from jsonb_object_keys(item) as keys(key)
    loop
      if item_key not in (
        'contactPointId',
        'kind',
        'status',
        'commitmentSha256',
        'domain'
      ) then
        return false;
      end if;
    end loop;

    if item ? 'domain'
      and (
        coalesce(item ->> 'domain', '') !~ '^[a-z0-9](?:[a-z0-9.-]{1,251}[a-z0-9])?$'
        or item ->> 'domain' <> lower(item ->> 'domain')
      )
    then
      return false;
    end if;
  end loop;

  return true;
end;
$$;

create or replace function private.normalize_research_contact_commitments_v2(
  value jsonb
)
returns jsonb
language sql
immutable
parallel safe
set search_path = ''
as $$
  select coalesce(
    jsonb_agg(element order by element ->> 'contactPointId'),
    '[]'::jsonb
  )
  from jsonb_array_elements(value) as items(element);
$$;

revoke all on function private.research_sha256_v2(text)
  from public, anon, authenticated;
revoke all on function private.research_sources_are_valid_v2(text[])
  from public, anon, authenticated;
revoke all on function private.research_contact_commitments_are_valid_v2(jsonb)
  from public, anon, authenticated;
revoke all on function private.normalize_research_contact_commitments_v2(jsonb)
  from public, anon, authenticated;

-- Existing rows are protocol 1. New v2 callers opt in explicitly.
alter table public.research_runs
  add column execution_protocol smallint not null default 1
    check (execution_protocol in (1, 2)),
  add column attempt_count smallint not null default 0
    check (attempt_count between 0 and 10),
  add column max_attempts smallint not null default 3
    check (max_attempts between 1 and 10),
  add column dead_lettered_at timestamptz,
  add column dead_letter_reason text
    check (
      dead_letter_reason is null
      or length(trim(dead_letter_reason)) between 1 and 240
    ),
  add column verified_completion_id uuid;

alter table public.research_runs
  drop constraint research_runs_status_check,
  add constraint research_runs_status_check
    check (status in (
      'queued',
      'running',
      'paused',
      'stopping',
      'completed',
      'failed',
      'cancelled',
      'dead_lettered'
    )),
  add constraint research_runs_attempt_bounds_check
    check (attempt_count <= max_attempts),
  add constraint research_runs_dead_letter_check
    check (
      (
        status = 'dead_lettered'
        and dead_lettered_at is not null
        and dead_letter_reason is not null
      )
      or
      (
        status <> 'dead_lettered'
        and dead_lettered_at is null
      )
    );

-- Refuse to silently bless any pre-existing cross-run corruption.
do $migration_integrity$
begin
  if exists (
    select 1
    from public.research_events event
    join public.research_tasks task on task.id = event.task_id
    where event.task_id is not null
      and event.run_id <> task.run_id
  ) then
    raise exception using
      errcode = '23503',
      message = 'research_integrity_v2_cross_run_event';
  end if;

  if exists (
    select 1
    from public.research_candidates candidate
    join public.research_tasks task on task.id = candidate.task_id
    where candidate.run_id <> task.run_id
       or candidate.company_id <> task.company_id
  ) then
    raise exception using
      errcode = '23503',
      message = 'research_integrity_v2_cross_run_candidate';
  end if;
end;
$migration_integrity$;

alter table public.research_tasks
  add column claim_id uuid,
  add constraint research_tasks_run_id_id_key unique (run_id, id),
  add constraint research_tasks_run_id_id_company_id_key
    unique (run_id, id, company_id);

alter table public.research_events
  add column claim_id uuid,
  add column idempotency_key uuid,
  add column content_hash text
    check (
      content_hash is null
      or content_hash ~ '^[0-9a-f]{64}$'
    ),
  drop constraint research_events_task_id_fkey,
  add constraint research_events_run_task_fkey
    foreign key (run_id, task_id)
    references public.research_tasks(run_id, id)
    on delete cascade;

create unique index research_events_claim_sequence_uidx
  on public.research_events(claim_id, sequence)
  where claim_id is not null;
create unique index research_events_claim_idempotency_uidx
  on public.research_events(claim_id, idempotency_key)
  where claim_id is not null and idempotency_key is not null;

alter table public.research_candidates
  add column current_revision_id uuid,
  add column current_content_hash text
    check (
      current_content_hash is null
      or current_content_hash ~ '^[0-9a-f]{64}$'
    ),
  add column current_decision_id uuid,
  add column is_active boolean not null default true,
  add column committed_at timestamptz,
  add constraint research_candidates_run_task_id_key
    unique (run_id, task_id, id),
  add constraint research_candidates_id_run_key
    unique (id, run_id),
  drop constraint research_candidates_task_id_fkey,
  add constraint research_candidates_run_task_company_fkey
    foreign key (run_id, task_id, company_id)
    references public.research_tasks(run_id, id, company_id)
    on delete cascade;

create table public.research_run_claims (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null,
  claim_request_id uuid not null,
  attempt_no smallint not null check (attempt_no between 1 and 10),
  worker_id text not null
    check (
      length(worker_id) between 1 and 120
      and worker_id ~ '^[A-Za-z0-9._-]+$'
    ),
  available_sources text[] not null
    check (private.research_sources_are_valid_v2(available_sources)),
  token_sha256 text not null
    check (token_sha256 ~ '^[0-9a-f]{64}$'),
  status text not null default 'active'
    check (status in (
      'active',
      'completed',
      'failed',
      'expired',
      'revoked'
    )),
  lease_started_at timestamptz not null default now(),
  heartbeat_at timestamptz not null default now(),
  lease_expires_at timestamptz not null,
  absolute_expires_at timestamptz not null,
  cleanup_ledger_sha256 text not null
    check (cleanup_ledger_sha256 ~ '^[0-9a-f]{64}$'),
  cleanup_manifest_sha256 text not null
    check (cleanup_manifest_sha256 ~ '^[0-9a-f]{64}$'),
  cleanup_approved_at timestamptz not null,
  attio_people_sha256 text not null
    check (attio_people_sha256 ~ '^[0-9a-f]{64}$'),
  attio_manifest_sha256 text not null
    check (attio_manifest_sha256 ~ '^[0-9a-f]{64}$'),
  attio_snapshot_completed_at timestamptz not null,
  attio_people_count integer not null check (attio_people_count >= 0),
  pipedrive_people_sha256 text not null
    check (pipedrive_people_sha256 ~ '^[0-9a-f]{64}$'),
  pipedrive_manifest_sha256 text not null
    check (pipedrive_manifest_sha256 ~ '^[0-9a-f]{64}$'),
  pipedrive_snapshot_completed_at timestamptz not null,
  pipedrive_people_count integer not null check (pipedrive_people_count >= 0),
  suppression_set_sha256 text not null
    check (suppression_set_sha256 ~ '^[0-9a-f]{64}$'),
  input_expires_at timestamptz not null,
  ended_at timestamptz,
  end_code text
    check (
      end_code is null
      or length(trim(end_code)) between 1 and 120
    ),
  created_at timestamptz not null default now(),
  constraint research_run_claims_run_fkey
    foreign key (run_id)
    references public.research_runs(id)
    on delete restrict,
  constraint research_run_claims_run_id_id_key unique (run_id, id),
  constraint research_run_claims_run_attempt_key unique (run_id, attempt_no),
  constraint research_run_claims_worker_request_key
    unique (worker_id, claim_request_id),
  constraint research_run_claims_token_key unique (token_sha256),
  constraint research_run_claims_lease_bounds_check
    check (
      lease_started_at <= heartbeat_at
      and heartbeat_at <= lease_expires_at
      and lease_expires_at <= absolute_expires_at
    ),
  constraint research_run_claims_end_state_check
    check (
      (status = 'active' and ended_at is null and end_code is null)
      or
      (status <> 'active' and ended_at is not null and end_code is not null)
    )
);

create unique index research_run_claims_one_active_per_run_uidx
  on public.research_run_claims(run_id)
  where status = 'active';
create index research_run_claims_active_lease_idx
  on public.research_run_claims(lease_expires_at, run_id)
  where status = 'active';

alter table public.research_tasks
  add constraint research_tasks_run_claim_fkey
    foreign key (run_id, claim_id)
    references public.research_run_claims(run_id, id)
    on delete restrict;

alter table public.research_events
  add constraint research_events_run_claim_fkey
    foreign key (run_id, claim_id)
    references public.research_run_claims(run_id, id)
    on delete restrict,
  add constraint research_events_v2_identity_check
    check (
      claim_id is null
      or (idempotency_key is not null and content_hash is not null)
    );

create table public.research_candidate_revisions (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null,
  task_id uuid not null,
  candidate_id uuid not null,
  claim_id uuid,
  revision_no integer not null check (revision_no > 0),
  previous_revision_id uuid,
  name text not null check (length(trim(name)) between 1 and 240),
  job_title text not null check (length(trim(job_title)) between 1 and 240),
  role_category text not null
    check (length(trim(role_category)) between 1 and 120),
  source_kind text not null
    check (length(trim(source_kind)) between 1 and 120),
  source_url text not null check (source_url ~ '^https://'),
  evidence_excerpt text
    check (
      evidence_excerpt is null
      or length(evidence_excerpt) <= 4000
    ),
  evidence_content_hash text not null
    check (evidence_content_hash ~ '^[0-9a-f]{64}$'),
  crm_comparison text not null
    check (crm_comparison in (
      'already_in_attio',
      'pipedrive_only',
      'missing_from_both',
      'conflicting_multiple_matches',
      'unverifiable_no_email'
    )),
  email_status text not null
    check (email_status in (
      'public_email_found',
      'licensed_business_email_found',
      'not_publicly_found'
    )),
  confidence numeric(4,3) not null check (confidence between 0 and 1),
  contact_commitments jsonb not null default '[]'::jsonb
    check (
      private.research_contact_commitments_are_valid_v2(contact_commitments)
    ),
  content_hash text not null
    check (content_hash ~ '^[0-9a-f]{64}$'),
  observed_at timestamptz not null,
  created_at timestamptz not null default now(),
  constraint research_candidate_revisions_candidate_fkey
    foreign key (run_id, task_id, candidate_id)
    references public.research_candidates(run_id, task_id, id)
    on delete restrict,
  constraint research_candidate_revisions_claim_fkey
    foreign key (run_id, claim_id)
    references public.research_run_claims(run_id, id)
    on delete restrict,
  constraint research_candidate_revisions_candidate_id_id_key
    unique (candidate_id, id),
  constraint research_candidate_revisions_run_task_candidate_id_key
    unique (run_id, task_id, candidate_id, id),
  constraint research_candidate_revisions_candidate_revision_key
    unique (candidate_id, revision_no),
  constraint research_candidate_revisions_previous_fkey
    foreign key (candidate_id, previous_revision_id)
    references public.research_candidate_revisions(candidate_id, id)
    on delete restrict
);

create unique index research_candidate_revisions_claim_content_uidx
  on public.research_candidate_revisions(candidate_id, claim_id, content_hash)
  where claim_id is not null;
create index research_candidate_revisions_claim_idx
  on public.research_candidate_revisions(claim_id, created_at);

create table public.research_evidence_revisions (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null,
  task_id uuid not null,
  candidate_id uuid not null,
  candidate_revision_id uuid not null,
  claim_id uuid,
  source_kind text not null
    check (length(trim(source_kind)) between 1 and 120),
  source_url text not null check (source_url ~ '^https://'),
  excerpt text check (excerpt is null or length(excerpt) <= 4000),
  captured_at timestamptz not null,
  content_hash text not null
    check (content_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now(),
  constraint research_evidence_revisions_candidate_revision_fkey
    foreign key (run_id, task_id, candidate_id, candidate_revision_id)
    references public.research_candidate_revisions(
      run_id,
      task_id,
      candidate_id,
      id
    )
    on delete restrict,
  constraint research_evidence_revisions_claim_fkey
    foreign key (run_id, claim_id)
    references public.research_run_claims(run_id, id)
    on delete restrict,
  constraint research_evidence_revisions_revision_hash_key
    unique (candidate_revision_id, content_hash)
);

-- Convert each mutable legacy candidate into an immutable baseline revision.
with legacy as (
  select
    candidate.*,
    private.research_sha256_v2(
      jsonb_build_object(
        'sourceKind', candidate.source_kind,
        'sourceUrl', candidate.source_url,
        'excerpt', candidate.evidence_excerpt
      )::text
    ) as evidence_hash
  from public.research_candidates candidate
),
inserted as (
  insert into public.research_candidate_revisions (
    run_id,
    task_id,
    candidate_id,
    revision_no,
    name,
    job_title,
    role_category,
    source_kind,
    source_url,
    evidence_excerpt,
    evidence_content_hash,
    crm_comparison,
    email_status,
    confidence,
    contact_commitments,
    content_hash,
    observed_at,
    created_at
  )
  select
    legacy.run_id,
    legacy.task_id,
    legacy.id,
    1,
    legacy.name,
    legacy.job_title,
    legacy.role_category,
    legacy.source_kind,
    legacy.source_url,
    legacy.evidence_excerpt,
    legacy.evidence_hash,
    legacy.crm_comparison,
    legacy.email_status,
    legacy.confidence,
    '[]'::jsonb,
    private.research_sha256_v2(
      jsonb_build_object(
        'name', trim(legacy.name),
        'jobTitle', trim(legacy.job_title),
        'roleCategory', trim(legacy.role_category),
        'evidenceContentHash', legacy.evidence_hash,
        'crmComparison', legacy.crm_comparison,
        'emailStatus', legacy.email_status,
        'confidence', legacy.confidence,
        'contactCommitments', '[]'::jsonb
      )::text
    ),
    legacy.updated_at,
    legacy.created_at
  from legacy
  returning id, candidate_id, content_hash
)
update public.research_candidates candidate
set
  current_revision_id = inserted.id,
  current_content_hash = inserted.content_hash
from inserted
where candidate.id = inserted.candidate_id;

insert into public.research_evidence_revisions (
  run_id,
  task_id,
  candidate_id,
  candidate_revision_id,
  source_kind,
  source_url,
  excerpt,
  captured_at,
  content_hash,
  created_at
)
select
  candidate.run_id,
  candidate.task_id,
  candidate.id,
  revision.id,
  revision.source_kind,
  revision.source_url,
  revision.evidence_excerpt,
  revision.observed_at,
  revision.evidence_content_hash,
  revision.created_at
from public.research_candidates candidate
join public.research_candidate_revisions revision
  on revision.id = candidate.current_revision_id;

alter table public.research_candidates
  add constraint research_candidates_current_revision_fkey
    foreign key (id, current_revision_id)
    references public.research_candidate_revisions(candidate_id, id)
    on delete restrict;

create table public.research_run_completions (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null,
  claim_id uuid not null,
  manifest jsonb not null check (jsonb_typeof(manifest) = 'object'),
  manifest_sha256 text not null
    check (manifest_sha256 ~ '^[0-9a-f]{64}$'),
  candidate_set_sha256 text not null
    check (candidate_set_sha256 ~ '^[0-9a-f]{64}$'),
  task_set_sha256 text not null
    check (task_set_sha256 ~ '^[0-9a-f]{64}$'),
  suppression_set_sha256 text not null
    check (suppression_set_sha256 ~ '^[0-9a-f]{64}$'),
  company_count integer not null check (company_count >= 0),
  page_count integer not null check (page_count >= 0),
  candidate_count integer not null check (candidate_count >= 0),
  input_expires_at timestamptz not null,
  verified_at timestamptz not null default now(),
  constraint research_run_completions_run_fkey
    foreign key (run_id)
    references public.research_runs(id)
    on delete restrict,
  constraint research_run_completions_claim_fkey
    foreign key (run_id, claim_id)
    references public.research_run_claims(run_id, id)
    on delete restrict,
  constraint research_run_completions_run_key unique (run_id),
  constraint research_run_completions_claim_key unique (claim_id),
  constraint research_run_completions_run_id_id_key unique (run_id, id)
);

alter table public.research_runs
  add constraint research_runs_verified_completion_fkey
    foreign key (id, verified_completion_id)
    references public.research_run_completions(run_id, id)
    on delete restrict;

create table public.research_completion_candidate_revisions (
  completion_id uuid not null,
  run_id uuid not null,
  candidate_id uuid not null,
  revision_id uuid not null,
  content_hash text not null
    check (content_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now(),
  primary key (completion_id, candidate_id),
  constraint research_completion_candidate_revisions_completion_fkey
    foreign key (run_id, completion_id)
    references public.research_run_completions(run_id, id)
    on delete restrict,
  constraint research_completion_candidate_revisions_revision_fkey
    foreign key (candidate_id, revision_id)
    references public.research_candidate_revisions(candidate_id, id)
    on delete restrict
);

create table public.research_candidate_decisions (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null,
  candidate_id uuid not null,
  revision_id uuid not null,
  revision_content_hash text not null
    check (revision_content_hash ~ '^[0-9a-f]{64}$'),
  claim_id uuid,
  decision text not null
    check (decision in ('approved', 'rejected', 'investigate')),
  reason text not null
    check (length(trim(reason)) between 1 and 500),
  previous_decision_id uuid,
  -- Keep the historical actor identifier immutable even if the auth user is
  -- later removed. The service API validates the actor before calling the RPC.
  decided_by uuid,
  decided_at timestamptz not null default now(),
  suppression_set_sha256 text
    check (
      suppression_set_sha256 is null
      or suppression_set_sha256 ~ '^[0-9a-f]{64}$'
    ),
  input_expires_at timestamptz,
  created_at timestamptz not null default now(),
  constraint research_candidate_decisions_candidate_revision_fkey
    foreign key (candidate_id, revision_id)
    references public.research_candidate_revisions(candidate_id, id)
    on delete restrict,
  constraint research_candidate_decisions_claim_fkey
    foreign key (run_id, claim_id)
    references public.research_run_claims(run_id, id)
    on delete restrict,
  constraint research_candidate_decisions_candidate_id_id_key
    unique (candidate_id, id),
  constraint research_candidate_decisions_previous_fkey
    foreign key (candidate_id, previous_decision_id)
    references public.research_candidate_decisions(candidate_id, id)
    on delete restrict,
  constraint research_candidate_decisions_previous_key
    unique (previous_decision_id)
);

create index research_candidate_decisions_candidate_time_idx
  on public.research_candidate_decisions(candidate_id, decided_at desc);

insert into public.research_candidate_decisions (
  run_id,
  candidate_id,
  revision_id,
  revision_content_hash,
  decision,
  reason,
  decided_by,
  decided_at,
  created_at
)
select
  candidate.run_id,
  candidate.id,
  candidate.current_revision_id,
  candidate.current_content_hash,
  candidate.review_status,
  'legacy_projection_backfill',
  candidate.reviewed_by,
  candidate.reviewed_at,
  candidate.reviewed_at
from public.research_candidates candidate
where candidate.review_status <> 'pending';

update public.research_candidates candidate
set current_decision_id = decision.id
from public.research_candidate_decisions decision
where decision.candidate_id = candidate.id
  and decision.reason = 'legacy_projection_backfill';

alter table public.research_candidates
  add constraint research_candidates_current_decision_fkey
    foreign key (id, current_decision_id)
    references public.research_candidate_decisions(candidate_id, id)
    on delete restrict;

create table public.research_contact_handoffs (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null,
  candidate_id uuid not null,
  revision_id uuid not null,
  decision_id uuid not null,
  contact_point_id text not null
    check (
      length(contact_point_id) between 1 and 120
      and contact_point_id ~ '^[A-Za-z0-9._:-]+$'
    ),
  kind text not null check (kind in ('email', 'phone')),
  commitment_sha256 text not null
    check (commitment_sha256 ~ '^[0-9a-f]{64}$'),
  status text not null default 'requested'
    check (status in (
      'requested',
      'claimed',
      'verified',
      'blocked',
      'expired'
    )),
  worker_id text
    check (
      worker_id is null
      or (
        length(worker_id) between 1 and 120
        and worker_id ~ '^[A-Za-z0-9._-]+$'
      )
    ),
  claim_request_id uuid,
  token_sha256 text
    check (
      token_sha256 is null
      or token_sha256 ~ '^[0-9a-f]{64}$'
    ),
  attempt_count smallint not null default 0
    check (attempt_count between 0 and 3),
  lease_expires_at timestamptz,
  requested_by uuid references auth.users(id) on delete set null,
  requested_at timestamptz not null default now(),
  claimed_at timestamptz,
  verified_at timestamptz,
  failure_code text
    check (
      failure_code is null
      or length(trim(failure_code)) between 1 and 120
    ),
  updated_at timestamptz not null default now(),
  constraint research_contact_handoffs_candidate_revision_fkey
    foreign key (candidate_id, revision_id)
    references public.research_candidate_revisions(candidate_id, id)
    on delete restrict,
  constraint research_contact_handoffs_candidate_decision_fkey
    foreign key (candidate_id, decision_id)
    references public.research_candidate_decisions(candidate_id, id)
    on delete restrict,
  constraint research_contact_handoffs_decision_point_key
    unique (decision_id, contact_point_id),
  constraint research_contact_handoffs_token_key unique (token_sha256),
  constraint research_contact_handoffs_claim_state_check
    check (
      (
        status = 'claimed'
        and worker_id is not null
        and claim_request_id is not null
        and token_sha256 is not null
        and claimed_at is not null
        and lease_expires_at is not null
      )
      or status <> 'claimed'
    )
);

create index research_contact_handoffs_status_idx
  on public.research_contact_handoffs(status, requested_at);

create table private.research_contact_point_values (
  id uuid primary key default gen_random_uuid(),
  handoff_id uuid not null unique
    references public.research_contact_handoffs(id) on delete restrict,
  kind text not null check (kind in ('email', 'phone')),
  contact_value text not null
    check (length(contact_value) between 3 and 320),
  commitment_sha256 text not null
    check (commitment_sha256 ~ '^[0-9a-f]{64}$'),
  verified_at timestamptz not null default now()
);

create or replace function private.prevent_research_immutable_change_v2()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception using
    errcode = '55000',
    message = 'research_integrity_v2_append_only';
end;
$$;

revoke all on function private.prevent_research_immutable_change_v2()
  from public, anon, authenticated;

create trigger research_candidate_revisions_append_only
before update or delete on public.research_candidate_revisions
for each row execute function private.prevent_research_immutable_change_v2();

create trigger research_evidence_revisions_append_only
before update or delete on public.research_evidence_revisions
for each row execute function private.prevent_research_immutable_change_v2();

create trigger research_run_completions_append_only
before update or delete on public.research_run_completions
for each row execute function private.prevent_research_immutable_change_v2();

create trigger research_completion_candidate_revisions_append_only
before update or delete on public.research_completion_candidate_revisions
for each row execute function private.prevent_research_immutable_change_v2();

create trigger research_candidate_decisions_append_only
before update or delete on public.research_candidate_decisions
for each row execute function private.prevent_research_immutable_change_v2();

create trigger research_contact_point_values_append_only
before update or delete on private.research_contact_point_values
for each row execute function private.prevent_research_immutable_change_v2();

create or replace function private.current_research_suppression_hash_v2()
returns text
language sql
stable
set search_path = ''
as $$
  select private.research_sha256_v2(
    coalesce(
      string_agg(lower(trim(suppression.email)), E'\n'
        order by lower(trim(suppression.email))),
      ''
    )
  )
  from public.outreach_suppressions suppression;
$$;

create or replace function private.require_active_research_claim_v2(
  claim_id uuid,
  claim_token text
)
returns public.research_run_claims
language plpgsql
stable
set search_path = ''
as $$
#variable_conflict use_variable
declare
  claim public.research_run_claims;
begin
  if claim_token is null
    or octet_length(claim_token) not between 32 and 256
  then
    raise exception using
      errcode = '22023',
      message = 'research_claim_token_invalid';
  end if;

  select stored_claim.*
  into claim
  from public.research_run_claims stored_claim
  where stored_claim.id = claim_id
    and stored_claim.status = 'active'
    and stored_claim.token_sha256 =
      private.research_sha256_v2(claim_token)
    and stored_claim.lease_expires_at > statement_timestamp()
    and stored_claim.absolute_expires_at > statement_timestamp();

  if not found then
    raise exception using
      errcode = '28000',
      message = 'research_claim_not_active';
  end if;

  return claim;
end;
$$;

revoke all on function private.current_research_suppression_hash_v2()
  from public, anon, authenticated;
revoke all on function private.require_active_research_claim_v2(uuid, text)
  from public, anon, authenticated;

create or replace function public.reclaim_expired_research_claims_v2(
  claim_limit integer default 100
)
returns integer
language plpgsql
set search_path = ''
as $$
#variable_conflict use_variable
declare
  expired_claim public.research_run_claims;
  reclaimed_count integer := 0;
begin
  if claim_limit not between 1 and 500 then
    raise exception using
      errcode = '22023',
      message = 'research_reclaim_limit_invalid';
  end if;

  for expired_claim in
    select claim.*
    from public.research_run_claims claim
    where claim.status = 'active'
      and (
        claim.lease_expires_at <= statement_timestamp()
        or claim.absolute_expires_at <= statement_timestamp()
      )
    order by claim.lease_expires_at, claim.id
    for update skip locked
    limit claim_limit
  loop
    update public.research_run_claims
    set
      status = 'expired',
      ended_at = statement_timestamp(),
      end_code = 'lease_expired'
    where id = expired_claim.id
      and status = 'active';

    if found then
      update public.research_tasks
      set
        claim_id = null,
        status = 'waiting',
        progress = 0,
        page_count = 0,
        contacts_found = 0,
        current_url = null,
        page_title = null,
        "current_role" = null,
        last_error = null,
        started_at = null,
        completed_at = null,
        updated_by = null,
        updated_at = statement_timestamp()
      where run_id = expired_claim.run_id
        and claim_id = expired_claim.id;

      update public.research_candidates
      set
        is_active = false,
        committed_at = null,
        review_status = 'pending',
        reviewed_by = null,
        reviewed_at = null,
        current_decision_id = null,
        updated_by = null,
        updated_at = statement_timestamp()
      where run_id = expired_claim.run_id
        and committed_at is null;

      update public.research_runs run
      set
        status = case
          when run.attempt_count >= run.max_attempts then 'dead_lettered'
          else 'queued'
        end,
        failure_message = 'research_worker_lease_expired',
        completed_at = case
          when run.attempt_count >= run.max_attempts
            then statement_timestamp()
          else null
        end,
        dead_lettered_at = case
          when run.attempt_count >= run.max_attempts
            then statement_timestamp()
          else null
        end,
        dead_letter_reason = case
          when run.attempt_count >= run.max_attempts
            then 'maximum_claim_attempts_exhausted'
          else null
        end,
        updated_by = null,
        updated_at = statement_timestamp()
      where run.id = expired_claim.run_id
        and run.execution_protocol = 2
        and run.verified_completion_id is null
        and run.status in ('running', 'paused', 'stopping');

      reclaimed_count := reclaimed_count + 1;
    end if;
  end loop;

  return reclaimed_count;
end;
$$;

create or replace function public.claim_research_run_v2(
  claim_request_id uuid,
  worker_id text,
  available_sources text[],
  claim_token text,
  input_attestation jsonb,
  lease_seconds integer default 120
)
returns jsonb
language plpgsql
set search_path = ''
as $$
#variable_conflict use_variable
declare
  stored_claim public.research_run_claims;
  selected_run public.research_runs;
  token_hash text;
  cleanup_ledger_hash text;
  cleanup_manifest_hash text;
  cleanup_approved_at timestamptz;
  attio_people_hash text;
  attio_manifest_hash text;
  attio_completed_at timestamptz;
  attio_count integer;
  pipedrive_people_hash text;
  pipedrive_manifest_hash text;
  pipedrive_completed_at timestamptz;
  pipedrive_count integer;
  input_expires_at timestamptz;
  suppression_hash text;
  bounded_lease_seconds integer;
  next_attempt smallint;
begin
  if claim_request_id is null
    or worker_id is null
    or length(worker_id) not between 1 and 120
    or worker_id !~ '^[A-Za-z0-9._-]+$'
    or not private.research_sources_are_valid_v2(available_sources)
    or claim_token is null
    or octet_length(claim_token) not between 32 and 256
    or lease_seconds not between 30 and 300
    or jsonb_typeof(input_attestation) <> 'object'
    or input_attestation ->> 'schemaVersion' <> '2'
  then
    raise exception using
      errcode = '22023',
      message = 'research_claim_request_invalid';
  end if;

  token_hash := private.research_sha256_v2(claim_token);

  select claim.*
  into stored_claim
  from public.research_run_claims claim
  where claim.worker_id = claim_research_run_v2.worker_id
    and claim.claim_request_id = claim_research_run_v2.claim_request_id;

  if found then
    if stored_claim.token_sha256 <> token_hash then
      raise exception using
        errcode = '28000',
        message = 'research_claim_request_token_mismatch';
    end if;

    if stored_claim.status = 'active'
      and stored_claim.lease_expires_at > statement_timestamp()
      and stored_claim.absolute_expires_at > statement_timestamp()
    then
      return jsonb_build_object(
        'claimed', true,
        'idempotent', true,
        'claimId', stored_claim.id,
        'runId', stored_claim.run_id,
        'attemptNo', stored_claim.attempt_no,
        'leaseExpiresAt', stored_claim.lease_expires_at,
        'inputExpiresAt', stored_claim.input_expires_at
      );
    end if;

    return jsonb_build_object(
      'claimed', false,
      'reason', 'claim_request_already_ended'
    );
  end if;

  begin
    cleanup_ledger_hash :=
      input_attestation #>> '{cleanup,ledgerSha256}';
    cleanup_manifest_hash :=
      input_attestation #>> '{cleanup,manifestSha256}';
    cleanup_approved_at :=
      (input_attestation #>> '{cleanup,approvedAt}')::timestamptz;
    attio_people_hash :=
      input_attestation #>> '{attio,peopleSha256}';
    attio_manifest_hash :=
      input_attestation #>> '{attio,manifestSha256}';
    attio_completed_at :=
      (input_attestation #>> '{attio,completedAt}')::timestamptz;
    attio_count :=
      (input_attestation #>> '{attio,peopleCount}')::integer;
    pipedrive_people_hash :=
      input_attestation #>> '{pipedrive,peopleSha256}';
    pipedrive_manifest_hash :=
      input_attestation #>> '{pipedrive,manifestSha256}';
    pipedrive_completed_at :=
      (input_attestation #>> '{pipedrive,completedAt}')::timestamptz;
    pipedrive_count :=
      (input_attestation #>> '{pipedrive,peopleCount}')::integer;
  exception
    when invalid_text_representation or datetime_field_overflow then
      raise exception using
        errcode = '22023',
        message = 'research_input_attestation_invalid';
  end;

  if cleanup_ledger_hash !~ '^[0-9a-f]{64}$'
    or cleanup_manifest_hash !~ '^[0-9a-f]{64}$'
    or attio_people_hash !~ '^[0-9a-f]{64}$'
    or attio_manifest_hash !~ '^[0-9a-f]{64}$'
    or pipedrive_people_hash !~ '^[0-9a-f]{64}$'
    or pipedrive_manifest_hash !~ '^[0-9a-f]{64}$'
    or attio_count < 0
    or pipedrive_count < 0
    or cleanup_approved_at > statement_timestamp() + interval '5 minutes'
    or attio_completed_at > statement_timestamp() + interval '5 minutes'
    or pipedrive_completed_at > statement_timestamp() + interval '5 minutes'
    or cleanup_approved_at < statement_timestamp() - interval '24 hours'
    or attio_completed_at < cleanup_approved_at
    or pipedrive_completed_at < cleanup_approved_at
    or attio_completed_at < statement_timestamp() - interval '24 hours'
    or pipedrive_completed_at < statement_timestamp() - interval '24 hours'
  then
    raise exception using
      errcode = '22023',
      message = 'research_input_attestation_stale_or_invalid';
  end if;

  input_expires_at := least(
    cleanup_approved_at + interval '24 hours',
    attio_completed_at + interval '24 hours',
    pipedrive_completed_at + interval '24 hours'
  );
  suppression_hash := private.current_research_suppression_hash_v2();
  bounded_lease_seconds := greatest(30, least(300, lease_seconds));

  perform public.reclaim_expired_research_claims_v2(100);

  select run.*
  into selected_run
  from public.research_runs run
  where run.execution_protocol = 2
    and run.status = 'queued'
    and run.attempt_count < run.max_attempts
    and run.verified_completion_id is null
    and jsonb_typeof(run.configuration -> 'requestedSources') = 'array'
    and jsonb_array_length(run.configuration -> 'requestedSources')
      between 1 and 4
    and not exists (
      select 1
      from jsonb_array_elements_text(
        run.configuration -> 'requestedSources'
      ) as requested(source)
      where not (requested.source = any(available_sources))
    )
    and (
      select count(*)
      from public.research_tasks task
      where task.run_id = run.id
        and task.status = 'waiting'
    ) = run.company_limit
  order by run.created_at, run.id
  for update skip locked
  limit 1;

  if not found then
    return jsonb_build_object('claimed', false);
  end if;

  next_attempt := selected_run.attempt_count + 1;

  update public.research_runs
  set
    status = 'running',
    attempt_count = next_attempt,
    failure_message = null,
    started_at = coalesce(started_at, statement_timestamp()),
    completed_at = null,
    dead_lettered_at = null,
    dead_letter_reason = null,
    updated_by = null,
    updated_at = statement_timestamp()
  where id = selected_run.id;

  insert into public.research_run_claims (
    run_id,
    claim_request_id,
    attempt_no,
    worker_id,
    available_sources,
    token_sha256,
    lease_started_at,
    heartbeat_at,
    lease_expires_at,
    absolute_expires_at,
    cleanup_ledger_sha256,
    cleanup_manifest_sha256,
    cleanup_approved_at,
    attio_people_sha256,
    attio_manifest_sha256,
    attio_snapshot_completed_at,
    attio_people_count,
    pipedrive_people_sha256,
    pipedrive_manifest_sha256,
    pipedrive_snapshot_completed_at,
    pipedrive_people_count,
    suppression_set_sha256,
    input_expires_at
  )
  values (
    selected_run.id,
    claim_request_id,
    next_attempt,
    worker_id,
    available_sources,
    token_hash,
    statement_timestamp(),
    statement_timestamp(),
    statement_timestamp() + make_interval(secs => bounded_lease_seconds),
    statement_timestamp() + interval '2 hours',
    cleanup_ledger_hash,
    cleanup_manifest_hash,
    cleanup_approved_at,
    attio_people_hash,
    attio_manifest_hash,
    attio_completed_at,
    attio_count,
    pipedrive_people_hash,
    pipedrive_manifest_hash,
    pipedrive_completed_at,
    pipedrive_count,
    suppression_hash,
    input_expires_at
  )
  returning * into stored_claim;

  update public.research_tasks
  set
    claim_id = stored_claim.id,
    status = 'waiting',
    progress = 0,
    page_count = 0,
    contacts_found = 0,
    current_url = null,
    page_title = null,
    "current_role" = null,
    last_error = null,
    started_at = null,
    completed_at = null,
    updated_by = null,
    updated_at = statement_timestamp()
  where run_id = selected_run.id;

  update public.research_candidates
  set
    is_active = false,
    committed_at = null,
    review_status = 'pending',
    reviewed_by = null,
    reviewed_at = null,
    current_decision_id = null,
    updated_by = null,
    updated_at = statement_timestamp()
  where run_id = selected_run.id;

  return jsonb_build_object(
    'claimed', true,
    'idempotent', false,
    'claimId', stored_claim.id,
    'runId', selected_run.id,
    'name', selected_run.name,
    'attemptNo', next_attempt,
    'requestedSources', selected_run.configuration -> 'requestedSources',
    'configuration', selected_run.configuration,
    'leaseExpiresAt', stored_claim.lease_expires_at,
    'inputExpiresAt', stored_claim.input_expires_at
  );
end;
$$;

create or replace function public.heartbeat_research_claim_v2(
  claim_id uuid,
  claim_token text,
  lease_seconds integer default 120
)
returns jsonb
language plpgsql
set search_path = ''
as $$
#variable_conflict use_variable
declare
  claim public.research_run_claims;
  next_expiry timestamptz;
begin
  if lease_seconds not between 30 and 300 then
    raise exception using
      errcode = '22023',
      message = 'research_heartbeat_lease_invalid';
  end if;

  claim := private.require_active_research_claim_v2(
    claim_id,
    claim_token
  );
  next_expiry := least(
    statement_timestamp() + make_interval(secs => lease_seconds),
    claim.absolute_expires_at
  );

  update public.research_run_claims
  set
    heartbeat_at = statement_timestamp(),
    lease_expires_at = next_expiry
  where id = claim.id
    and status = 'active';

  return jsonb_build_object(
    'accepted', true,
    'claimId', claim.id,
    'runId', claim.run_id,
    'leaseExpiresAt', next_expiry
  );
end;
$$;

create or replace function public.fail_research_claim_v2(
  claim_id uuid,
  claim_token text,
  failure_code text
)
returns jsonb
language plpgsql
set search_path = ''
as $$
#variable_conflict use_variable
declare
  claim public.research_run_claims;
  run public.research_runs;
  next_status text;
begin
  if failure_code is null
    or length(trim(failure_code)) not between 1 and 120
    or failure_code !~ '^[A-Za-z0-9._:-]+$'
  then
    raise exception using
      errcode = '22023',
      message = 'research_failure_code_invalid';
  end if;

  claim := private.require_active_research_claim_v2(
    claim_id,
    claim_token
  );

  select stored_run.*
  into run
  from public.research_runs stored_run
  where stored_run.id = claim.run_id
  for update;

  next_status := case
    when run.attempt_count >= run.max_attempts then 'dead_lettered'
    else 'queued'
  end;

  update public.research_run_claims
  set
    status = 'failed',
    ended_at = statement_timestamp(),
    end_code = trim(failure_code)
  where id = claim.id;

  update public.research_tasks
  set
    claim_id = null,
    status = 'waiting',
    progress = 0,
    page_count = 0,
    contacts_found = 0,
    current_url = null,
    page_title = null,
    "current_role" = null,
    last_error = null,
    started_at = null,
    completed_at = null,
    updated_by = null,
    updated_at = statement_timestamp()
  where run_id = claim.run_id
    and claim_id = claim.id;

  update public.research_candidates
  set
    is_active = false,
    committed_at = null,
    review_status = 'pending',
    reviewed_by = null,
    reviewed_at = null,
    current_decision_id = null,
    updated_by = null,
    updated_at = statement_timestamp()
  where run_id = claim.run_id
    and committed_at is null;

  update public.research_runs
  set
    status = next_status,
    failure_message = trim(failure_code),
    completed_at = case
      when next_status = 'dead_lettered' then statement_timestamp()
      else null
    end,
    dead_lettered_at = case
      when next_status = 'dead_lettered' then statement_timestamp()
      else null
    end,
    dead_letter_reason = case
      when next_status = 'dead_lettered'
        then 'maximum_claim_attempts_exhausted'
      else null
    end,
    updated_by = null,
    updated_at = statement_timestamp()
  where id = claim.run_id;

  return jsonb_build_object(
    'accepted', true,
    'runId', claim.run_id,
    'status', next_status
  );
end;
$$;

create or replace function public.transition_research_run_v2(
  run_id uuid,
  action text,
  actor_id uuid
)
returns jsonb
language plpgsql
set search_path = ''
as $$
#variable_conflict use_variable
declare
  run public.research_runs;
  claim public.research_run_claims;
  next_status text;
begin
  if action not in ('pause', 'resume', 'stop', 'cancel')
    or actor_id is null
  then
    raise exception using
      errcode = '22023',
      message = 'research_run_transition_invalid';
  end if;

  perform public.reclaim_expired_research_claims_v2(100);

  select stored_run.*
  into run
  from public.research_runs stored_run
  where stored_run.id = run_id
    and stored_run.execution_protocol = 2
  for update;

  if not found then
    raise exception using
      errcode = 'P0002',
      message = 'research_run_not_found';
  end if;

  select stored_claim.*
  into claim
  from public.research_run_claims stored_claim
  where stored_claim.run_id = run.id
    and stored_claim.status = 'active'
    and stored_claim.lease_expires_at > statement_timestamp()
    and stored_claim.absolute_expires_at > statement_timestamp()
  for update;

  next_status := case action
    when 'pause' then
      case when run.status = 'running' then 'paused' else null end
    when 'resume' then
      case
        when run.status = 'paused' and claim.id is not null then 'running'
        when run.status = 'paused' then 'queued'
        else null
      end
    when 'stop' then
      case
        when run.status in ('running', 'paused') and claim.id is not null
          then 'stopping'
        when run.status in ('queued', 'paused') then 'cancelled'
        else null
      end
    when 'cancel' then
      case
        when run.status in ('queued', 'running', 'paused', 'stopping')
          then 'cancelled'
        else null
      end
  end;

  if next_status is null then
    raise exception using
      errcode = '55000',
      message = 'research_run_transition_not_allowed';
  end if;

  if action = 'cancel' and claim.id is not null then
    update public.research_run_claims
    set
      status = 'revoked',
      ended_at = statement_timestamp(),
      end_code = 'cancelled_by_user'
    where id = claim.id;

    update public.research_tasks
    set
      claim_id = null,
      status = case
        when status in ('completed', 'review', 'skipped') then status
        else 'skipped'
      end,
      completed_at = coalesce(completed_at, statement_timestamp()),
      updated_by = actor_id,
      updated_at = statement_timestamp()
    where research_tasks.run_id = run.id
      and research_tasks.claim_id = claim.id;
  end if;

  update public.research_runs
  set
    status = next_status,
    completed_at = case
      when next_status = 'cancelled' then statement_timestamp()
      else completed_at
    end,
    updated_by = actor_id,
    updated_at = statement_timestamp()
  where id = run.id;

  return jsonb_build_object(
    'accepted', true,
    'runId', run.id,
    'status', next_status
  );
end;
$$;

create or replace function public.transition_research_task_v2(
  claim_id uuid,
  claim_token text,
  task_id uuid,
  next_status text,
  progress integer,
  page_count integer,
  contacts_found integer,
  current_url text default null,
  page_title text default null,
  task_role text default null,
  last_error text default null
)
returns jsonb
language plpgsql
set search_path = ''
as $$
#variable_conflict use_variable
declare
  claim public.research_run_claims;
  task public.research_tasks;
  run_status text;
begin
  if next_status not in (
    'waiting',
    'running',
    'review',
    'completed',
    'failed',
    'skipped'
  )
    or progress not between 0 and 100
    or page_count < 0
    or contacts_found < 0
    or (
      current_url is not null
      and (
        current_url !~ '^https://'
        or length(current_url) > 2000
      )
    )
    or (page_title is not null and length(page_title) > 500)
    or (task_role is not null and length(task_role) > 240)
    or (last_error is not null and length(last_error) > 1000)
  then
    raise exception using
      errcode = '22023',
      message = 'research_task_transition_invalid';
  end if;

  claim := private.require_active_research_claim_v2(
    claim_id,
    claim_token
  );

  select stored_task.*
  into task
  from public.research_tasks stored_task
  where stored_task.id = task_id
    and stored_task.run_id = claim.run_id
    and stored_task.claim_id = claim.id
  for update;

  if not found then
    raise exception using
      errcode = '23503',
      message = 'research_task_claim_mismatch';
  end if;

  select status
  into run_status
  from public.research_runs
  where id = claim.run_id;

  if run_status not in ('running', 'stopping')
    or (
      run_status = 'stopping'
      and task.status = 'waiting'
      and next_status = 'running'
    )
    or not (
      (task.status = 'waiting' and next_status in ('waiting', 'running', 'skipped'))
      or
      (
        task.status = 'running'
        and next_status in (
          'running',
          'review',
          'completed',
          'failed',
          'skipped'
        )
      )
      or
      (task.status = 'review' and next_status in ('review', 'completed'))
      or task.status = next_status
    )
    or progress < task.progress
    or page_count < task.page_count
    or contacts_found < task.contacts_found
  then
    raise exception using
      errcode = '55000',
      message = 'research_task_transition_not_allowed';
  end if;

  update public.research_tasks
  set
    status = next_status,
    progress = progress,
    page_count = page_count,
    contacts_found = contacts_found,
    current_url = current_url,
    page_title = page_title,
    "current_role" = task_role,
    last_error = case
      when next_status = 'failed' then last_error
      else null
    end,
    started_at = case
      when next_status = 'running'
        then coalesce(research_tasks.started_at, statement_timestamp())
      else research_tasks.started_at
    end,
    completed_at = case
      when next_status in ('review', 'completed', 'failed', 'skipped')
        then coalesce(research_tasks.completed_at, statement_timestamp())
      else null
    end,
    updated_by = null,
    updated_at = statement_timestamp()
  where id = task.id;

  return jsonb_build_object(
    'accepted', true,
    'taskId', task.id,
    'status', next_status
  );
end;
$$;

create or replace function public.append_research_candidate_revision_v2(
  claim_id uuid,
  claim_token text,
  task_id uuid,
  external_candidate_id text,
  candidate_payload jsonb
)
returns jsonb
language plpgsql
set search_path = ''
as $$
#variable_conflict use_variable
declare
  claim public.research_run_claims;
  task public.research_tasks;
  candidate public.research_candidates;
  existing_revision public.research_candidate_revisions;
  revision_id uuid := gen_random_uuid();
  previous_revision_id uuid;
  revision_no integer;
  candidate_name text;
  job_title text;
  role_category text;
  source_kind text;
  source_url text;
  evidence_excerpt text;
  crm_comparison text;
  email_status text;
  confidence numeric(4,3);
  observed_at timestamptz;
  contact_commitments jsonb;
  normalized_commitments jsonb;
  evidence_hash text;
  content_hash text;
begin
  claim := private.require_active_research_claim_v2(
    claim_id,
    claim_token
  );

  if external_candidate_id is null
    or length(trim(external_candidate_id)) not between 1 and 240
    or jsonb_typeof(candidate_payload) <> 'object'
  then
    raise exception using
      errcode = '22023',
      message = 'research_candidate_payload_invalid';
  end if;

  select stored_task.*
  into task
  from public.research_tasks stored_task
  where stored_task.id = task_id
    and stored_task.run_id = claim.run_id
    and stored_task.claim_id = claim.id
    and stored_task.status in ('running', 'review')
  for update;

  if not found then
    raise exception using
      errcode = '23503',
      message = 'research_candidate_task_claim_mismatch';
  end if;

  begin
    candidate_name := trim(candidate_payload ->> 'name');
    job_title := trim(candidate_payload ->> 'jobTitle');
    role_category := trim(candidate_payload ->> 'roleCategory');
    source_kind := trim(candidate_payload ->> 'sourceKind');
    source_url := trim(candidate_payload ->> 'sourceUrl');
    evidence_excerpt := candidate_payload ->> 'evidenceExcerpt';
    crm_comparison := candidate_payload ->> 'crmComparison';
    email_status := candidate_payload ->> 'emailStatus';
    confidence := (candidate_payload ->> 'confidence')::numeric(4,3);
    observed_at := (candidate_payload ->> 'observedAt')::timestamptz;
    contact_commitments :=
      coalesce(candidate_payload -> 'contactCommitments', '[]'::jsonb);
  exception
    when invalid_text_representation or datetime_field_overflow then
      raise exception using
        errcode = '22023',
        message = 'research_candidate_payload_invalid';
  end;

  if length(candidate_name) not between 1 and 240
    or length(job_title) not between 1 and 240
    or length(role_category) not between 1 and 120
    or source_kind not in (
      'official_website',
      'apollo',
      'companies_house',
      'procurement'
    )
    or source_url !~ '^https://'
    or length(source_url) > 2000
    or (
      evidence_excerpt is not null
      and length(evidence_excerpt) > 4000
    )
    or crm_comparison not in (
      'already_in_attio',
      'pipedrive_only',
      'missing_from_both',
      'conflicting_multiple_matches',
      'unverifiable_no_email'
    )
    or email_status not in (
      'public_email_found',
      'licensed_business_email_found',
      'not_publicly_found'
    )
    or confidence not between 0 and 1
    or observed_at < claim.lease_started_at - interval '5 minutes'
    or observed_at > statement_timestamp() + interval '5 minutes'
    or not private.research_contact_commitments_are_valid_v2(
      contact_commitments
    )
  then
    raise exception using
      errcode = '22023',
      message = 'research_candidate_payload_invalid';
  end if;

  normalized_commitments :=
    private.normalize_research_contact_commitments_v2(
      contact_commitments
    );
  evidence_hash := private.research_sha256_v2(
    jsonb_build_object(
      'sourceKind', source_kind,
      'sourceUrl', source_url,
      'excerpt', evidence_excerpt
    )::text
  );
  content_hash := private.research_sha256_v2(
    jsonb_build_object(
      'name', candidate_name,
      'jobTitle', job_title,
      'roleCategory', role_category,
      'evidenceContentHash', evidence_hash,
      'crmComparison', crm_comparison,
      'emailStatus', email_status,
      'confidence', confidence,
      'contactCommitments', normalized_commitments
    )::text
  );

  select stored_candidate.*
  into candidate
  from public.research_candidates stored_candidate
  where stored_candidate.run_id = claim.run_id
    and stored_candidate.external_candidate_id = trim(external_candidate_id)
  for update;

  if found and candidate.task_id <> task.id then
    raise exception using
      errcode = '23503',
      message = 'research_candidate_cross_task_identity';
  end if;

  if not found then
    insert into public.research_candidates (
      run_id,
      task_id,
      external_candidate_id,
      company_id,
      name,
      job_title,
      role_category,
      source_kind,
      source_url,
      evidence_excerpt,
      crm_comparison,
      email_status,
      confidence,
      review_status,
      is_active,
      created_by,
      updated_by,
      created_at,
      updated_at
    )
    values (
      claim.run_id,
      task.id,
      trim(external_candidate_id),
      task.company_id,
      candidate_name,
      job_title,
      role_category,
      source_kind,
      source_url,
      evidence_excerpt,
      crm_comparison,
      email_status,
      confidence,
      'pending',
      true,
      null,
      null,
      statement_timestamp(),
      statement_timestamp()
    )
    returning * into candidate;
  end if;

  select revision.*
  into existing_revision
  from public.research_candidate_revisions revision
  where revision.candidate_id = candidate.id
    and revision.claim_id = claim.id
    and revision.content_hash = content_hash;

  if found then
    return jsonb_build_object(
      'accepted', true,
      'idempotent', true,
      'candidateId', candidate.id,
      'revisionId', existing_revision.id,
      'contentHash', existing_revision.content_hash,
      'evidenceContentHash', existing_revision.evidence_content_hash,
      'isCurrent', candidate.current_revision_id = existing_revision.id
    );
  end if;

  previous_revision_id := candidate.current_revision_id;
  select coalesce(max(revision.revision_no), 0) + 1
  into revision_no
  from public.research_candidate_revisions revision
  where revision.candidate_id = candidate.id;

  insert into public.research_candidate_revisions (
    id,
    run_id,
    task_id,
    candidate_id,
    claim_id,
    revision_no,
    previous_revision_id,
    name,
    job_title,
    role_category,
    source_kind,
    source_url,
    evidence_excerpt,
    evidence_content_hash,
    crm_comparison,
    email_status,
    confidence,
    contact_commitments,
    content_hash,
    observed_at
  )
  values (
    revision_id,
    claim.run_id,
    task.id,
    candidate.id,
    claim.id,
    revision_no,
    previous_revision_id,
    candidate_name,
    job_title,
    role_category,
    source_kind,
    source_url,
    evidence_excerpt,
    evidence_hash,
    crm_comparison,
    email_status,
    confidence,
    normalized_commitments,
    content_hash,
    observed_at
  );

  insert into public.research_evidence_revisions (
    run_id,
    task_id,
    candidate_id,
    candidate_revision_id,
    claim_id,
    source_kind,
    source_url,
    excerpt,
    captured_at,
    content_hash
  )
  values (
    claim.run_id,
    task.id,
    candidate.id,
    revision_id,
    claim.id,
    source_kind,
    source_url,
    evidence_excerpt,
    observed_at,
    evidence_hash
  );

  update public.research_candidates
  set
    name = candidate_name,
    job_title = job_title,
    role_category = role_category,
    source_kind = source_kind,
    source_url = source_url,
    evidence_excerpt = evidence_excerpt,
    crm_comparison = crm_comparison,
    email_status = email_status,
    confidence = confidence,
    review_status = 'pending',
    reviewed_by = null,
    reviewed_at = null,
    current_revision_id = revision_id,
    current_content_hash = content_hash,
    current_decision_id = null,
    is_active = true,
    committed_at = null,
    updated_by = null,
    updated_at = statement_timestamp()
  where id = candidate.id;

  update public.research_tasks
  set
    contacts_found = greatest(
      research_tasks.contacts_found,
      (
        select count(*)::integer
        from public.research_candidates current_candidate
        join public.research_candidate_revisions current_revision
          on current_revision.id = current_candidate.current_revision_id
        where current_candidate.task_id = task.id
          and current_candidate.is_active
          and current_revision.claim_id = claim.id
      )
    ),
    updated_by = null,
    updated_at = statement_timestamp()
  where id = task.id;

  return jsonb_build_object(
    'accepted', true,
    'idempotent', false,
    'candidateId', candidate.id,
    'revisionId', revision_id,
    'contentHash', content_hash,
    'evidenceContentHash', evidence_hash,
    'isCurrent', true
  );
end;
$$;

create or replace function public.complete_research_run_v2(
  claim_id uuid,
  claim_token text,
  manifest_text text,
  manifest_sha256 text
)
returns jsonb
language plpgsql
set search_path = ''
as $$
#variable_conflict use_variable
declare
  claim public.research_run_claims;
  completion public.research_run_completions;
  manifest jsonb;
  calculated_manifest_hash text;
  candidate_set_hash text;
  task_set_hash text;
  company_count integer;
  page_count integer;
  candidate_count integer;
begin
  if manifest_text is null
    or octet_length(manifest_text) not between 2 and 262144
    or manifest_sha256 !~ '^[0-9a-f]{64}$'
  then
    raise exception using
      errcode = '22023',
      message = 'research_completion_manifest_invalid';
  end if;

  calculated_manifest_hash :=
    private.research_sha256_v2(manifest_text);
  if calculated_manifest_hash <> manifest_sha256 then
    raise exception using
      errcode = '22023',
      message = 'research_completion_manifest_hash_mismatch';
  end if;

  begin
    manifest := manifest_text::jsonb;
  exception
    when invalid_text_representation then
      raise exception using
        errcode = '22023',
        message = 'research_completion_manifest_invalid';
  end;

  select stored_completion.*
  into completion
  from public.research_run_completions stored_completion
  join public.research_run_claims stored_claim
    on stored_claim.id = stored_completion.claim_id
  where stored_completion.claim_id = claim_id
    and stored_claim.token_sha256 =
      private.research_sha256_v2(claim_token);

  if found then
    if completion.manifest_sha256 <> manifest_sha256 then
      raise exception using
        errcode = '23505',
        message = 'research_completion_already_committed';
    end if;
    return jsonb_build_object(
      'accepted', true,
      'idempotent', true,
      'completionId', completion.id,
      'runId', completion.run_id,
      'manifestSha256', completion.manifest_sha256
    );
  end if;

  claim := private.require_active_research_claim_v2(
    claim_id,
    claim_token
  );

  if claim.input_expires_at <= statement_timestamp()
    or claim.suppression_set_sha256 <>
      private.current_research_suppression_hash_v2()
    or jsonb_typeof(manifest) <> 'object'
    or manifest ->> 'schemaVersion' <> '2'
    or manifest ->> 'kind' <> 'research_execution_completion'
    or manifest ->> 'runId' <> claim.run_id::text
    or manifest ->> 'claimId' <> claim.id::text
    or jsonb_typeof(manifest -> 'counts') <> 'object'
    or jsonb_typeof(manifest -> 'inputs') <> 'object'
    or (
      select coalesce(array_agg(key order by key), array[]::text[])
      from jsonb_object_keys(manifest) as top_level(key)
    ) <> array[
      'candidateSetSha256',
      'claimId',
      'counts',
      'inputs',
      'kind',
      'runId',
      'schemaVersion',
      'taskSetSha256'
    ]::text[]
    or (
      select coalesce(array_agg(key order by key), array[]::text[])
      from jsonb_object_keys(manifest -> 'counts') as count_key(key)
    ) <> array[
      'companiesChecked',
      'pagesInspected',
      'peopleFound'
    ]::text[]
    or (
      select coalesce(array_agg(key order by key), array[]::text[])
      from jsonb_object_keys(manifest -> 'inputs') as input_key(key)
    ) <> array[
      'attioManifestSha256',
      'attioPeopleSha256',
      'cleanupLedgerSha256',
      'cleanupManifestSha256',
      'pipedriveManifestSha256',
      'pipedrivePeopleSha256',
      'suppressionSetSha256'
    ]::text[]
  then
    raise exception using
      errcode = '55000',
      message = 'research_completion_freshness_or_shape_denied';
  end if;

  if manifest #>> '{inputs,cleanupLedgerSha256}' <>
      claim.cleanup_ledger_sha256
    or manifest #>> '{inputs,cleanupManifestSha256}' <>
      claim.cleanup_manifest_sha256
    or manifest #>> '{inputs,attioPeopleSha256}' <>
      claim.attio_people_sha256
    or manifest #>> '{inputs,attioManifestSha256}' <>
      claim.attio_manifest_sha256
    or manifest #>> '{inputs,pipedrivePeopleSha256}' <>
      claim.pipedrive_people_sha256
    or manifest #>> '{inputs,pipedriveManifestSha256}' <>
      claim.pipedrive_manifest_sha256
    or manifest #>> '{inputs,suppressionSetSha256}' <>
      claim.suppression_set_sha256
  then
    raise exception using
      errcode = '55000',
      message = 'research_completion_input_attestation_mismatch';
  end if;

  if exists (
    select 1
    from public.research_tasks task
    where task.run_id = claim.run_id
      and (
        task.claim_id is distinct from claim.id
        or task.status not in ('review', 'completed', 'skipped')
      )
  ) then
    raise exception using
      errcode = '55000',
      message = 'research_completion_tasks_not_terminal';
  end if;

  select
    count(*)::integer,
    coalesce(sum(task.page_count), 0)::integer,
    private.research_sha256_v2(
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
  into company_count, page_count, task_set_hash
  from public.research_tasks task
  where task.run_id = claim.run_id
    and task.claim_id = claim.id;

  select
    count(*)::integer,
    private.research_sha256_v2(
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
  into candidate_count, candidate_set_hash
  from public.research_candidates candidate
  join public.research_candidate_revisions revision
    on revision.id = candidate.current_revision_id
  where candidate.run_id = claim.run_id
    and candidate.is_active
    and revision.claim_id = claim.id;

  begin
    if manifest ->> 'candidateSetSha256' <> candidate_set_hash
      or manifest ->> 'taskSetSha256' <> task_set_hash
      or (manifest #>> '{counts,companiesChecked}')::integer <>
        company_count
      or (manifest #>> '{counts,pagesInspected}')::integer <>
        page_count
      or (manifest #>> '{counts,peopleFound}')::integer <>
        candidate_count
    then
      raise exception using
        errcode = '55000',
        message = 'research_completion_manifest_state_mismatch';
    end if;
  exception
    when invalid_text_representation or numeric_value_out_of_range then
      raise exception using
        errcode = '22023',
        message = 'research_completion_manifest_counts_invalid';
  end;

  insert into public.research_run_completions (
    run_id,
    claim_id,
    manifest,
    manifest_sha256,
    candidate_set_sha256,
    task_set_sha256,
    suppression_set_sha256,
    company_count,
    page_count,
    candidate_count,
    input_expires_at
  )
  values (
    claim.run_id,
    claim.id,
    manifest,
    manifest_sha256,
    candidate_set_hash,
    task_set_hash,
    claim.suppression_set_sha256,
    company_count,
    page_count,
    candidate_count,
    claim.input_expires_at
  )
  returning * into completion;

  insert into public.research_completion_candidate_revisions (
    completion_id,
    run_id,
    candidate_id,
    revision_id,
    content_hash
  )
  select
    completion.id,
    claim.run_id,
    candidate.id,
    revision.id,
    revision.content_hash
  from public.research_candidates candidate
  join public.research_candidate_revisions revision
    on revision.id = candidate.current_revision_id
  where candidate.run_id = claim.run_id
    and candidate.is_active
    and revision.claim_id = claim.id;

  update public.research_candidates candidate
  set
    committed_at = statement_timestamp(),
    updated_by = null,
    updated_at = statement_timestamp()
  where candidate.run_id = claim.run_id
    and candidate.is_active
    and exists (
      select 1
      from public.research_candidate_revisions revision
      where revision.id = candidate.current_revision_id
        and revision.claim_id = claim.id
    );

  update public.research_run_claims
  set
    status = 'completed',
    ended_at = statement_timestamp(),
    end_code = 'manifest_verified'
  where id = claim.id;

  update public.research_runs
  set
    status = 'completed',
    companies_checked = company_count,
    pages_inspected = page_count,
    people_found = candidate_count,
    failure_message = null,
    verified_completion_id = completion.id,
    completed_at = statement_timestamp(),
    updated_by = null,
    updated_at = statement_timestamp()
  where id = claim.run_id
    and execution_protocol = 2
    and status in ('running', 'stopping');

  if not found then
    raise exception using
      errcode = '55000',
      message = 'research_completion_run_transition_denied';
  end if;

  return jsonb_build_object(
    'accepted', true,
    'idempotent', false,
    'completionId', completion.id,
    'runId', claim.run_id,
    'manifestSha256', completion.manifest_sha256,
    'candidateSetSha256', candidate_set_hash,
    'taskSetSha256', task_set_hash
  );
end;
$$;

create or replace function public.decide_research_candidate_v2(
  candidate_id uuid,
  expected_revision_id uuid,
  expected_content_hash text,
  decision text,
  reason text,
  actor_id uuid
)
returns jsonb
language plpgsql
set search_path = ''
as $$
#variable_conflict use_variable
declare
  candidate public.research_candidates;
  revision public.research_candidate_revisions;
  claim public.research_run_claims;
  decision_row public.research_candidate_decisions;
  handoff_id uuid;
  public_email_count integer;
  contact_point_id text;
  commitment_hash text;
begin
  if expected_content_hash !~ '^[0-9a-f]{64}$'
    or decision not in ('approved', 'rejected', 'investigate')
    or reason is null
    or length(trim(reason)) not between 1 and 500
    or actor_id is null
  then
    raise exception using
      errcode = '22023',
      message = 'research_decision_request_invalid';
  end if;

  select stored_candidate.*
  into candidate
  from public.research_candidates stored_candidate
  where stored_candidate.id = candidate_id
  for update;

  if not found
    or not candidate.is_active
    or candidate.committed_at is null
    or candidate.current_revision_id is distinct from expected_revision_id
    or candidate.current_content_hash is distinct from expected_content_hash
  then
    raise exception using
      errcode = '55000',
      message = 'research_decision_stale_candidate';
  end if;

  select stored_revision.*
  into revision
  from public.research_candidate_revisions stored_revision
  join public.research_completion_candidate_revisions committed_revision
    on committed_revision.candidate_id = stored_revision.candidate_id
   and committed_revision.revision_id = stored_revision.id
  join public.research_run_completions completion
    on completion.id = committed_revision.completion_id
   and completion.run_id = committed_revision.run_id
  where stored_revision.id = expected_revision_id
    and stored_revision.candidate_id = candidate.id
    and stored_revision.content_hash = expected_content_hash
    and completion.run_id = candidate.run_id;

  if not found then
    raise exception using
      errcode = '55000',
      message = 'research_decision_revision_not_committed';
  end if;

  select stored_claim.*
  into claim
  from public.research_run_claims stored_claim
  where stored_claim.id = revision.claim_id
    and stored_claim.run_id = candidate.run_id
    and stored_claim.status = 'completed';

  if not found
    or claim.input_expires_at <= statement_timestamp()
    or claim.suppression_set_sha256 <>
      private.current_research_suppression_hash_v2()
  then
    raise exception using
      errcode = '55000',
      message = 'research_decision_freshness_or_suppression_denied';
  end if;

  select
    count(*)::integer,
    max(commitment ->> 'contactPointId'),
    max(commitment ->> 'commitmentSha256')
  into public_email_count, contact_point_id, commitment_hash
  from jsonb_array_elements(revision.contact_commitments)
    as commitments(commitment)
  where commitment ->> 'kind' = 'email'
    and commitment ->> 'status' = 'public';

  if decision = 'approved'
    and (
      revision.crm_comparison not in ('pipedrive_only', 'missing_from_both')
      or revision.email_status <> 'public_email_found'
      or revision.confidence < 0.65
      or public_email_count <> 1
    )
  then
    raise exception using
      errcode = '55000',
      message = 'research_decision_approval_ineligible';
  end if;

  insert into public.research_candidate_decisions (
    run_id,
    candidate_id,
    revision_id,
    revision_content_hash,
    claim_id,
    decision,
    reason,
    previous_decision_id,
    decided_by,
    suppression_set_sha256,
    input_expires_at
  )
  values (
    candidate.run_id,
    candidate.id,
    revision.id,
    revision.content_hash,
    claim.id,
    decision,
    trim(reason),
    candidate.current_decision_id,
    actor_id,
    claim.suppression_set_sha256,
    claim.input_expires_at
  )
  returning * into decision_row;

  update public.research_candidates
  set
    review_status = decision,
    reviewed_by = actor_id,
    reviewed_at = decision_row.decided_at,
    current_decision_id = decision_row.id,
    updated_by = actor_id,
    updated_at = decision_row.decided_at
  where id = candidate.id;

  if decision = 'approved' then
    insert into public.research_contact_handoffs (
      run_id,
      candidate_id,
      revision_id,
      decision_id,
      contact_point_id,
      kind,
      commitment_sha256,
      requested_by
    )
    values (
      candidate.run_id,
      candidate.id,
      revision.id,
      decision_row.id,
      contact_point_id,
      'email',
      commitment_hash,
      actor_id
    )
    returning id into handoff_id;
  else
    update public.research_contact_handoffs
    set
      status = 'blocked',
      failure_code = 'superseded_by_human_decision',
      updated_at = statement_timestamp()
    where research_contact_handoffs.candidate_id = candidate.id
      and status in ('requested', 'claimed');
  end if;

  return jsonb_build_object(
    'accepted', true,
    'decisionId', decision_row.id,
    'candidateId', candidate.id,
    'decision', decision,
    'handoffId', handoff_id,
    'crmWritebackAuthorized', false,
    'outreachAuthorized', false
  );
end;
$$;

create or replace function public.claim_research_contact_handoff_v2(
  handoff_id uuid,
  claim_request_id uuid,
  worker_id text,
  claim_token text,
  lease_seconds integer default 120
)
returns jsonb
language plpgsql
set search_path = ''
as $$
#variable_conflict use_variable
declare
  handoff public.research_contact_handoffs;
  claim public.research_run_claims;
  token_hash text;
begin
  if claim_request_id is null
    or worker_id is null
    or length(worker_id) not between 1 and 120
    or worker_id !~ '^[A-Za-z0-9._-]+$'
    or claim_token is null
    or octet_length(claim_token) not between 32 and 256
    or lease_seconds not between 30 and 300
  then
    raise exception using
      errcode = '22023',
      message = 'research_handoff_claim_invalid';
  end if;

  token_hash := private.research_sha256_v2(claim_token);

  select stored_handoff.*
  into handoff
  from public.research_contact_handoffs stored_handoff
  where stored_handoff.id = handoff_id
  for update;

  if not found then
    raise exception using
      errcode = 'P0002',
      message = 'research_handoff_not_found';
  end if;

  if handoff.status = 'claimed'
    and handoff.claim_request_id = claim_request_id
    and handoff.worker_id = worker_id
    and handoff.token_sha256 = token_hash
    and handoff.lease_expires_at > statement_timestamp()
  then
    return jsonb_build_object(
      'claimed', true,
      'idempotent', true,
      'handoffId', handoff.id,
      'contactPointId', handoff.contact_point_id,
      'kind', handoff.kind,
      'leaseExpiresAt', handoff.lease_expires_at
    );
  end if;

  select stored_claim.*
  into claim
  from public.research_candidate_revisions revision
  join public.research_run_claims stored_claim
    on stored_claim.id = revision.claim_id
  join public.research_candidates candidate
    on candidate.id = revision.candidate_id
  where revision.id = handoff.revision_id
    and candidate.current_revision_id = revision.id
    and candidate.current_decision_id = handoff.decision_id
    and candidate.review_status = 'approved'
    and stored_claim.status = 'completed';

  if not found
    or claim.input_expires_at <= statement_timestamp()
    or claim.suppression_set_sha256 <>
      private.current_research_suppression_hash_v2()
  then
    update public.research_contact_handoffs
    set
      status = 'blocked',
      failure_code = 'freshness_or_suppression_gate',
      updated_at = statement_timestamp()
    where id = handoff.id;

    return jsonb_build_object(
      'claimed', false,
      'reason', 'freshness_or_suppression_gate'
    );
  end if;

  if handoff.status not in ('requested', 'claimed')
    or (
      handoff.status = 'claimed'
      and handoff.lease_expires_at > statement_timestamp()
    )
    or handoff.attempt_count >= 3
  then
    return jsonb_build_object(
      'claimed', false,
      'reason', 'handoff_not_available'
    );
  end if;

  update public.research_contact_handoffs
  set
    status = 'claimed',
    worker_id = worker_id,
    claim_request_id = claim_request_id,
    token_sha256 = token_hash,
    attempt_count = handoff.attempt_count + 1,
    claimed_at = statement_timestamp(),
    lease_expires_at =
      statement_timestamp() + make_interval(secs => lease_seconds),
    failure_code = null,
    updated_at = statement_timestamp()
  where id = handoff.id
  returning * into handoff;

  return jsonb_build_object(
    'claimed', true,
    'idempotent', false,
    'handoffId', handoff.id,
    'contactPointId', handoff.contact_point_id,
    'kind', handoff.kind,
    'leaseExpiresAt', handoff.lease_expires_at
  );
end;
$$;

create or replace function public.submit_research_contact_handoff_v2(
  handoff_id uuid,
  claim_token text,
  contact_value text,
  commitment_salt text
)
returns jsonb
language plpgsql
set search_path = ''
as $$
#variable_conflict use_variable
declare
  handoff public.research_contact_handoffs;
  claim public.research_run_claims;
  normalized_value text;
  calculated_commitment text;
begin
  if claim_token is null
    or octet_length(claim_token) not between 32 and 256
    or contact_value is null
    or commitment_salt is null
    or octet_length(commitment_salt) not between 16 and 256
  then
    raise exception using
      errcode = '22023',
      message = 'research_handoff_submission_invalid';
  end if;

  select stored_handoff.*
  into handoff
  from public.research_contact_handoffs stored_handoff
  where stored_handoff.id = handoff_id
    and stored_handoff.status = 'claimed'
    and stored_handoff.token_sha256 =
      private.research_sha256_v2(claim_token)
    and stored_handoff.lease_expires_at > statement_timestamp()
  for update;

  if not found then
    raise exception using
      errcode = '28000',
      message = 'research_handoff_claim_not_active';
  end if;

  if handoff.kind <> 'email' then
    raise exception using
      errcode = '0A000',
      message = 'research_handoff_kind_not_supported';
  end if;

  normalized_value := lower(trim(contact_value));
  if length(normalized_value) not between 3 and 320
    or normalized_value !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
  then
    raise exception using
      errcode = '22023',
      message = 'research_handoff_email_invalid';
  end if;

  calculated_commitment := private.research_sha256_v2(
    commitment_salt || E'\x1f' || normalized_value
  );
  if calculated_commitment <> handoff.commitment_sha256 then
    raise exception using
      errcode = '22023',
      message = 'research_handoff_commitment_mismatch';
  end if;

  select stored_claim.*
  into claim
  from public.research_candidate_revisions revision
  join public.research_run_claims stored_claim
    on stored_claim.id = revision.claim_id
  join public.research_candidates candidate
    on candidate.id = revision.candidate_id
  where revision.id = handoff.revision_id
    and candidate.current_revision_id = revision.id
    and candidate.current_decision_id = handoff.decision_id
    and candidate.review_status = 'approved'
    and stored_claim.status = 'completed';

  if not found
    or claim.input_expires_at <= statement_timestamp()
    or claim.suppression_set_sha256 <>
      private.current_research_suppression_hash_v2()
    or exists (
      select 1
      from public.outreach_suppressions suppression
      where lower(trim(suppression.email)) = normalized_value
    )
  then
    raise exception using
      errcode = '55000',
      message = 'research_handoff_freshness_or_suppression_denied';
  end if;

  insert into private.research_contact_point_values (
    handoff_id,
    kind,
    contact_value,
    commitment_sha256
  )
  values (
    handoff.id,
    handoff.kind,
    normalized_value,
    calculated_commitment
  );

  update public.research_contact_handoffs
  set
    status = 'verified',
    verified_at = statement_timestamp(),
    failure_code = null,
    updated_at = statement_timestamp()
  where id = handoff.id;

  return jsonb_build_object(
    'accepted', true,
    'handoffId', handoff.id,
    'status', 'verified',
    'crmWritebackAuthorized', false,
    'outreachAuthorized', false
  );
end;
$$;

alter table public.research_run_claims enable row level security;
alter table public.research_candidate_revisions enable row level security;
alter table public.research_evidence_revisions enable row level security;
alter table public.research_run_completions enable row level security;
alter table public.research_completion_candidate_revisions
  enable row level security;
alter table public.research_candidate_decisions enable row level security;
alter table public.research_contact_handoffs enable row level security;
alter table private.research_contact_point_values enable row level security;

revoke all on public.research_run_claims
  from public, anon, authenticated;
revoke all on public.research_candidate_revisions
  from public, anon, authenticated;
revoke all on public.research_evidence_revisions
  from public, anon, authenticated;
revoke all on public.research_run_completions
  from public, anon, authenticated;
revoke all on public.research_completion_candidate_revisions
  from public, anon, authenticated;
revoke all on public.research_candidate_decisions
  from public, anon, authenticated;
revoke all on public.research_contact_handoffs
  from public, anon, authenticated;
revoke all on private.research_contact_point_values
  from public, anon, authenticated;

-- GSD users may inspect non-secret evidence and decisions. Claim verifiers,
-- handoff verifier hashes, and clear contact values remain service-only.
grant select on public.research_candidate_revisions to authenticated;
grant select on public.research_evidence_revisions to authenticated;
grant select on public.research_run_completions to authenticated;
grant select on public.research_completion_candidate_revisions
  to authenticated;
grant select on public.research_candidate_decisions to authenticated;

create policy "GSD employees read research candidate revisions"
on public.research_candidate_revisions for select to authenticated
using (
  lower(coalesce((select auth.jwt()) ->> 'email', ''))
    like '%@gsdecorating.com'
);

create policy "GSD employees read research evidence revisions"
on public.research_evidence_revisions for select to authenticated
using (
  lower(coalesce((select auth.jwt()) ->> 'email', ''))
    like '%@gsdecorating.com'
);

create policy "GSD employees read research run completions"
on public.research_run_completions for select to authenticated
using (
  lower(coalesce((select auth.jwt()) ->> 'email', ''))
    like '%@gsdecorating.com'
);

create policy "GSD employees read research completion candidates"
on public.research_completion_candidate_revisions
for select to authenticated
using (
  lower(coalesce((select auth.jwt()) ->> 'email', ''))
    like '%@gsdecorating.com'
);

create policy "GSD employees read research candidate decisions"
on public.research_candidate_decisions for select to authenticated
using (
  lower(coalesce((select auth.jwt()) ->> 'email', ''))
    like '%@gsdecorating.com'
);

grant usage on schema private to service_role;
grant execute on function private.research_sha256_v2(text)
  to service_role;
grant execute on function private.research_sources_are_valid_v2(text[])
  to service_role;
grant execute on function private.research_contact_commitments_are_valid_v2(
  jsonb
) to service_role;
grant execute on function private.normalize_research_contact_commitments_v2(
  jsonb
) to service_role;
grant execute on function private.current_research_suppression_hash_v2()
  to service_role;
grant execute on function private.require_active_research_claim_v2(uuid, text)
  to service_role;

grant select, insert, update on public.research_run_claims
  to service_role;
grant select, insert on public.research_candidate_revisions
  to service_role;
grant select, insert on public.research_evidence_revisions
  to service_role;
grant select, insert on public.research_run_completions
  to service_role;
grant select, insert on public.research_completion_candidate_revisions
  to service_role;
grant select, insert on public.research_candidate_decisions
  to service_role;
grant select, insert, update on public.research_contact_handoffs
  to service_role;
grant select, insert on private.research_contact_point_values
  to service_role;

-- PostgreSQL grants PUBLIC execute on new functions by default. Remove that
-- before granting only the server-side role.
revoke all on function public.reclaim_expired_research_claims_v2(integer)
  from public, anon, authenticated;
revoke all on function public.claim_research_run_v2(
  uuid,
  text,
  text[],
  text,
  jsonb,
  integer
) from public, anon, authenticated;
revoke all on function public.heartbeat_research_claim_v2(
  uuid,
  text,
  integer
) from public, anon, authenticated;
revoke all on function public.fail_research_claim_v2(uuid, text, text)
  from public, anon, authenticated;
revoke all on function public.transition_research_run_v2(uuid, text, uuid)
  from public, anon, authenticated;
revoke all on function public.transition_research_task_v2(
  uuid,
  text,
  uuid,
  text,
  integer,
  integer,
  integer,
  text,
  text,
  text,
  text
) from public, anon, authenticated;
revoke all on function public.append_research_candidate_revision_v2(
  uuid,
  text,
  uuid,
  text,
  jsonb
) from public, anon, authenticated;
revoke all on function public.complete_research_run_v2(
  uuid,
  text,
  text,
  text
) from public, anon, authenticated;
revoke all on function public.decide_research_candidate_v2(
  uuid,
  uuid,
  text,
  text,
  text,
  uuid
) from public, anon, authenticated;
revoke all on function public.claim_research_contact_handoff_v2(
  uuid,
  uuid,
  text,
  text,
  integer
) from public, anon, authenticated;
revoke all on function public.submit_research_contact_handoff_v2(
  uuid,
  text,
  text,
  text
) from public, anon, authenticated;

grant execute on function public.reclaim_expired_research_claims_v2(integer)
  to service_role;
grant execute on function public.claim_research_run_v2(
  uuid,
  text,
  text[],
  text,
  jsonb,
  integer
) to service_role;
grant execute on function public.heartbeat_research_claim_v2(
  uuid,
  text,
  integer
) to service_role;
grant execute on function public.fail_research_claim_v2(uuid, text, text)
  to service_role;
grant execute on function public.transition_research_run_v2(uuid, text, uuid)
  to service_role;
grant execute on function public.transition_research_task_v2(
  uuid,
  text,
  uuid,
  text,
  integer,
  integer,
  integer,
  text,
  text,
  text,
  text
) to service_role;
grant execute on function public.append_research_candidate_revision_v2(
  uuid,
  text,
  uuid,
  text,
  jsonb
) to service_role;
grant execute on function public.complete_research_run_v2(
  uuid,
  text,
  text,
  text
) to service_role;
grant execute on function public.decide_research_candidate_v2(
  uuid,
  uuid,
  text,
  text,
  text,
  uuid
) to service_role;
grant execute on function public.claim_research_contact_handoff_v2(
  uuid,
  uuid,
  text,
  text,
  integer
) to service_role;
grant execute on function public.submit_research_contact_handoff_v2(
  uuid,
  text,
  text,
  text
) to service_role;

comment on table public.research_run_claims is
  'Protocol-v2 durable worker leases. Only SHA-256 token verifiers are stored.';
comment on table public.research_candidate_revisions is
  'Append-only candidate revisions; research_candidates remains a compatibility projection.';
comment on table public.research_evidence_revisions is
  'Append-only source evidence with independently verifiable content hashes.';
comment on table public.research_candidate_decisions is
  'Append-only human review decisions pinned to an exact committed revision.';
comment on table public.research_run_completions is
  'Verified protocol-v2 completion manifests; insertion and run completion are one transaction.';
comment on table public.research_contact_handoffs is
  'Service-only metadata for narrowly scoped contact-point retrieval; never a CRM or outreach authorization.';
comment on table private.research_contact_point_values is
  'Restricted clear contact values verified against public revision commitments.';
comment on function public.complete_research_run_v2(uuid, text, text, text) is
  'Verifies exact task/candidate set hashes, input freshness, and suppression state before atomically completing a run.';
