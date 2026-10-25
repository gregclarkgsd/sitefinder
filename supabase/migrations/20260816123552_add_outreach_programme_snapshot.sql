create table if not exists public.outreach_programme_snapshot (
  snapshot_key text primary key,
  source_version text not null,
  audited_at timestamptz not null,
  phase1_rollout_list_entries integer not null check (phase1_rollout_list_entries >= 0),
  phase1_approved_controls integer not null check (phase1_approved_controls >= 0),
  phase1_strong_ready integer not null check (phase1_strong_ready >= 0),
  phase1_launch_review integer not null check (phase1_launch_review >= 0),
  phase1_blocked_role_mailboxes integer not null check (phase1_blocked_role_mailboxes >= 0),
  phase1_relationship_review integer not null check (phase1_relationship_review >= 0),
  phase1_sequence_state text not null,
  phase2_review_import integer not null check (phase2_review_import >= 0),
  phase2_blocked_role_mailboxes integer not null check (phase2_blocked_role_mailboxes >= 0),
  phase2_protected_warm_contacts integer not null check (phase2_protected_warm_contacts >= 0),
  phase2_protected_company_policies integer not null check (phase2_protected_company_policies >= 0),
  phase2_warm_leaks integer not null check (phase2_warm_leaks >= 0),
  phase2_unsafe_draft_size integer not null check (phase2_unsafe_draft_size >= 0),
  phase2_campaign_state text not null,
  global_hold integer not null check (global_hold >= 0),
  global_suppressed integer not null check (global_suppressed >= 0),
  maximum_initial_messages integer not null check (maximum_initial_messages >= 0),
  blocking_gate_count integer not null check (blocking_gate_count >= 0),
  broad_external_sending_approved boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint outreach_programme_snapshot_current_only
    check (snapshot_key = 'current')
);

alter table public.outreach_programme_snapshot enable row level security;

revoke all on public.outreach_programme_snapshot from anon, authenticated;
grant select on public.outreach_programme_snapshot to authenticated;

drop policy if exists "GSD employees read outreach programme snapshot"
  on public.outreach_programme_snapshot;
create policy "GSD employees read outreach programme snapshot"
on public.outreach_programme_snapshot for select to authenticated
using (lower(coalesce((select auth.jwt()) ->> 'email', '')) like '%@gsdecorating.com');

insert into public.outreach_programme_snapshot (
  snapshot_key,
  source_version,
  audited_at,
  phase1_rollout_list_entries,
  phase1_approved_controls,
  phase1_strong_ready,
  phase1_launch_review,
  phase1_blocked_role_mailboxes,
  phase1_relationship_review,
  phase1_sequence_state,
  phase2_review_import,
  phase2_blocked_role_mailboxes,
  phase2_protected_warm_contacts,
  phase2_protected_company_policies,
  phase2_warm_leaks,
  phase2_unsafe_draft_size,
  phase2_campaign_state,
  global_hold,
  global_suppressed,
  maximum_initial_messages,
  blocking_gate_count,
  broad_external_sending_approved,
  updated_at
) values (
  'current',
  '2026-08-16-governed-v2',
  '2026-08-16T12:31:53Z',
  1000,
  0,
  1546,
  1543,
  3,
  1948,
  'requires_browser_audit',
  3904,
  10,
  2206,
  31,
  0,
  5862,
  'requires_browser_audit',
  303,
  163,
  47824,
  8,
  false,
  now()
)
on conflict (snapshot_key) do update set
  source_version = excluded.source_version,
  audited_at = excluded.audited_at,
  phase1_rollout_list_entries = excluded.phase1_rollout_list_entries,
  phase1_approved_controls = excluded.phase1_approved_controls,
  phase1_strong_ready = excluded.phase1_strong_ready,
  phase1_launch_review = excluded.phase1_launch_review,
  phase1_blocked_role_mailboxes = excluded.phase1_blocked_role_mailboxes,
  phase1_relationship_review = excluded.phase1_relationship_review,
  phase1_sequence_state = excluded.phase1_sequence_state,
  phase2_review_import = excluded.phase2_review_import,
  phase2_blocked_role_mailboxes = excluded.phase2_blocked_role_mailboxes,
  phase2_protected_warm_contacts = excluded.phase2_protected_warm_contacts,
  phase2_protected_company_policies = excluded.phase2_protected_company_policies,
  phase2_warm_leaks = excluded.phase2_warm_leaks,
  phase2_unsafe_draft_size = excluded.phase2_unsafe_draft_size,
  phase2_campaign_state = excluded.phase2_campaign_state,
  global_hold = excluded.global_hold,
  global_suppressed = excluded.global_suppressed,
  maximum_initial_messages = excluded.maximum_initial_messages,
  blocking_gate_count = excluded.blocking_gate_count,
  broad_external_sending_approved = excluded.broad_external_sending_approved,
  updated_at = now();

comment on table public.outreach_programme_snapshot is
  'Read-only dashboard snapshot of the governed three-phase outreach programme. It cannot enrol contacts or send email.';

