set lock_timeout = '5s';
set statement_timeout = '2min';

alter table public.ccs_projects
  add column if not exists last_changed_fields text[] not null default '{}';

update public.ccs_projects
set last_changed_fields = array['Historical CCS update (field details unavailable)']
where last_changed_at > first_seen_at + interval '1 second'
  and cardinality(last_changed_fields) = 0;

comment on column public.ccs_projects.last_changed_fields is
  'Human-readable CCS fields changed in the most recent detected update.';

with ranked_running_syncs as (
  select
    id,
    row_number() over (order by started_at desc, id desc) as run_rank
  from public.ccs_sync_runs
  where status = 'running'
)
update public.ccs_sync_runs as runs
set
  status = 'failed',
  completed_at = coalesce(runs.completed_at, now()),
  error_message = coalesce(
    runs.error_message,
    'Superseded while enforcing the single-run CCS sync guard'
  )
from ranked_running_syncs
where runs.id = ranked_running_syncs.id
  and (
    ranked_running_syncs.run_rank > 1
    or runs.started_at < now() - interval '30 minutes'
  );

create unique index if not exists ccs_sync_runs_single_running_idx
  on public.ccs_sync_runs (status)
  where status = 'running';

alter table public.lead_tracking
  add column if not exists triage_status text not null default 'unreviewed',
  add column if not exists reviewed_at timestamptz,
  add column if not exists contacted_at timestamptz,
  add column if not exists contacted_source text,
  add column if not exists snoozed_until timestamptz,
  add column if not exists review_note text,
  add column if not exists triage_updated_by uuid references auth.users(id) on delete set null;

alter table public.lead_tracking
  drop constraint if exists lead_tracking_triage_status_check;

alter table public.lead_tracking
  add constraint lead_tracking_triage_status_check
  check (
    triage_status in (
      'unreviewed',
      'research',
      'ready',
      'contacted',
      'deferred',
      'not_fit'
    )
  );

alter table public.lead_tracking
  drop constraint if exists lead_tracking_contacted_source_check;

alter table public.lead_tracking
  add constraint lead_tracking_contacted_source_check
  check (
    contacted_source is null
    or (
      contacted_source in ('manual_history', 'pipeline_stage')
      and contacted_at is not null
    )
  );

update public.lead_tracking
set
  triage_status = case
    when stage in ('contacted', 'quoting', 'won', 'lost') then 'contacted'
    when stage = 'reviewing' then 'research'
    else triage_status
  end,
  reviewed_at = case
    when stage <> 'new' or next_action is not null then coalesce(reviewed_at, updated_at)
    else reviewed_at
  end,
  contacted_at = case
    when stage in ('contacted', 'quoting', 'won', 'lost') then coalesce(contacted_at, updated_at)
    else contacted_at
  end
where
  stage <> 'new'
  or next_action is not null;

create index if not exists lead_tracking_triage_idx
  on public.lead_tracking (triage_status, reviewed_at, snoozed_until);

create index if not exists lead_tracking_triage_updated_by_idx
  on public.lead_tracking (triage_updated_by)
  where triage_updated_by is not null;

comment on column public.lead_tracking.triage_status is
  'Team-visible Opportunity Inbox decision. Outreach queue state is deliberately separate.';
comment on column public.lead_tracking.reviewed_at is
  'When a person last reviewed the project. CCS changes after this time resurface the project.';
comment on column public.lead_tracking.contacted_at is
  'Manual historical contact timestamp when provider communication evidence is unavailable.';
comment on column public.lead_tracking.contacted_source is
  'Explicit provenance for manual historical or new pipeline-stage contact evidence. Legacy pipeline outcomes remain null.';
comment on column public.lead_tracking.snoozed_until is
  'Defers the opportunity without losing it. Expired deferrals return to the active inbox.';

create or replace function public.enforce_lead_tracking_triage_audit()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  actor_id uuid := (select auth.uid());
  triage_changed boolean;
begin
  if actor_id is null then
    return new;
  end if;

  triage_changed := case
    when tg_op = 'INSERT' then
      new.triage_status <> 'unreviewed'
      or new.reviewed_at is not null
      or new.contacted_at is not null
      or new.snoozed_until is not null
      or new.review_note is not null
    else
      row(
        new.triage_status,
        new.reviewed_at,
        new.contacted_at,
        new.contacted_source,
        new.snoozed_until,
        new.review_note
      ) is distinct from row(
        old.triage_status,
        old.reviewed_at,
        old.contacted_at,
        old.contacted_source,
        old.snoozed_until,
        old.review_note
      )
  end;

  if not triage_changed then
    new.triage_updated_by := case
      when tg_op = 'INSERT' then null
      else old.triage_updated_by
    end;
    return new;
  end if;

  new.triage_updated_by := actor_id;
  new.updated_at := statement_timestamp();

  if new.reviewed_at is not null and (
    tg_op = 'INSERT'
    or new.reviewed_at is distinct from old.reviewed_at
  ) then
    new.reviewed_at := statement_timestamp();
  end if;

  if new.contacted_at is not null and (
    tg_op = 'INSERT'
    or new.contacted_at is distinct from old.contacted_at
  ) then
    if new.contacted_source = 'manual_history' then
      if new.contacted_at > statement_timestamp() then
        raise exception 'Historical contact date cannot be in the future'
          using errcode = '22007';
      end if;
    else
      new.contacted_at := statement_timestamp();
    end if;
  end if;

  return new;
end;
$$;

revoke all on function public.enforce_lead_tracking_triage_audit()
  from public, anon, authenticated;

drop trigger if exists enforce_lead_tracking_triage_audit
  on public.lead_tracking;
create trigger enforce_lead_tracking_triage_audit
before insert or update on public.lead_tracking
for each row execute function public.enforce_lead_tracking_triage_audit();

create table public.opportunity_triage_events (
  id bigint generated always as identity primary key,
  project_id text not null,
  event_type text not null check (event_type in ('created', 'changed')),
  previous_decision jsonb,
  current_decision jsonb not null,
  actor_id uuid references auth.users(id) on delete set null,
  occurred_at timestamptz not null default now()
);

comment on table public.opportunity_triage_events is
  'Append-only audit of Opportunity Inbox decisions and manual contact provenance.';

create index opportunity_triage_events_project_time_idx
  on public.opportunity_triage_events (project_id, occurred_at desc);

alter table public.opportunity_triage_events enable row level security;
revoke all on public.opportunity_triage_events from public, anon, authenticated;
grant select on public.opportunity_triage_events to authenticated;
grant all on public.opportunity_triage_events to service_role;

create policy "GSD employees read opportunity decision history"
on public.opportunity_triage_events
for select
to authenticated
using (
  lower(coalesce((select auth.jwt()) ->> 'email', '')) like '%@gsdecorating.com'
);

create or replace function public.record_opportunity_triage_event()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  previous_decision jsonb;
  current_decision jsonb;
begin
  current_decision := jsonb_build_object(
    'triage_status', new.triage_status,
    'reviewed_at', new.reviewed_at,
    'contacted_at', new.contacted_at,
    'contacted_source', new.contacted_source,
    'snoozed_until', new.snoozed_until,
    'review_note', new.review_note
  );

  if tg_op = 'INSERT' then
    if current_decision = jsonb_build_object(
      'triage_status', 'unreviewed',
      'reviewed_at', null,
      'contacted_at', null,
      'contacted_source', null,
      'snoozed_until', null,
      'review_note', null
    ) then
      return new;
    end if;
  else
    previous_decision := jsonb_build_object(
      'triage_status', old.triage_status,
      'reviewed_at', old.reviewed_at,
      'contacted_at', old.contacted_at,
      'contacted_source', old.contacted_source,
      'snoozed_until', old.snoozed_until,
      'review_note', old.review_note
    );
    if current_decision = previous_decision then
      return new;
    end if;
  end if;

  insert into public.opportunity_triage_events (
    project_id,
    event_type,
    previous_decision,
    current_decision,
    actor_id,
    occurred_at
  )
  values (
    new.project_id,
    case when tg_op = 'INSERT' then 'created' else 'changed' end,
    previous_decision,
    current_decision,
    (select auth.uid()),
    statement_timestamp()
  );
  return new;
end;
$$;

revoke all on function public.record_opportunity_triage_event()
  from public, anon, authenticated;

create trigger record_opportunity_triage_event
after insert or update on public.lead_tracking
for each row execute function public.record_opportunity_triage_event();

revoke delete on public.lead_tracking from authenticated;
drop policy if exists "GSD employees delete lead tracking"
  on public.lead_tracking;

create table public.opportunity_inbox_cursors (
  user_id uuid primary key references auth.users(id) on delete cascade,
  last_checkpoint_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint opportunity_inbox_cursor_time_check
    check (last_checkpoint_at is null or last_checkpoint_at <= updated_at)
);

comment on table public.opportunity_inbox_cursors is
  'Private per-user checkpoint for the optional Since checkpoint Opportunity Inbox scope.';

create index opportunity_inbox_cursors_updated_idx
  on public.opportunity_inbox_cursors (updated_at desc);

alter table public.opportunity_inbox_cursors enable row level security;

revoke all on public.opportunity_inbox_cursors from public, anon, authenticated;
grant select, insert, update on public.opportunity_inbox_cursors to authenticated;
grant all on public.opportunity_inbox_cursors to service_role;

create or replace function public.enforce_opportunity_checkpoint_actor_time()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  actor_id uuid := (select auth.uid());
begin
  if actor_id is not null then
    new.user_id := actor_id;
    if new.last_checkpoint_at is null
      or new.last_checkpoint_at > statement_timestamp()
    then
      new.last_checkpoint_at := statement_timestamp();
    end if;
    new.updated_at := statement_timestamp();
    if tg_op = 'INSERT' then
      new.created_at := statement_timestamp();
    end if;
  end if;
  return new;
end;
$$;

revoke all on function public.enforce_opportunity_checkpoint_actor_time()
  from public, anon, authenticated;

create trigger enforce_opportunity_checkpoint_actor_time
before insert or update on public.opportunity_inbox_cursors
for each row execute function public.enforce_opportunity_checkpoint_actor_time();

create or replace function public.capture_opportunity_evidence_cutoff()
returns timestamptz
language sql
stable
security invoker
set search_path = ''
as $$
  select statement_timestamp();
$$;

revoke all on function public.capture_opportunity_evidence_cutoff()
  from public, anon;
grant execute on function public.capture_opportunity_evidence_cutoff()
  to authenticated, service_role;

create policy "GSD employees read their opportunity checkpoint"
on public.opportunity_inbox_cursors
for select
to authenticated
using (
  lower(coalesce((select auth.jwt()) ->> 'email', '')) like '%@gsdecorating.com'
  and user_id = (select auth.uid())
);

create policy "GSD employees create their opportunity checkpoint"
on public.opportunity_inbox_cursors
for insert
to authenticated
with check (
  lower(coalesce((select auth.jwt()) ->> 'email', '')) like '%@gsdecorating.com'
  and user_id = (select auth.uid())
);

create policy "GSD employees update their opportunity checkpoint"
on public.opportunity_inbox_cursors
for update
to authenticated
using (
  lower(coalesce((select auth.jwt()) ->> 'email', '')) like '%@gsdecorating.com'
  and user_id = (select auth.uid())
)
with check (
  lower(coalesce((select auth.jwt()) ->> 'email', '')) like '%@gsdecorating.com'
  and user_id = (select auth.uid())
);
