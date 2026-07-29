-- Make the Research Agent's review boundary a database invariant. Legacy or
-- unknown comparison values are treated as conflicts, never as approval.

update public.research_candidates
set
  crm_comparison = 'conflicting_multiple_matches',
  updated_by = null,
  updated_at = now()
where crm_comparison not in (
  'already_in_attio',
  'pipedrive_only',
  'missing_from_both',
  'conflicting_multiple_matches',
  'unverifiable_no_email'
);

update public.research_candidates
set
  email_status = 'not_publicly_found',
  updated_by = null,
  updated_at = now()
where email_status not in (
  'public_email_found',
  'not_publicly_found'
);

-- Existing approvals that do not meet the new gate go back to pending review.
-- This does not authorize or perform any CRM or outreach write.
update public.research_candidates
set
  review_status = 'pending',
  reviewed_by = null,
  reviewed_at = null,
  updated_by = null,
  updated_at = now()
where review_status = 'approved'
  and not (
    crm_comparison in ('pipedrive_only', 'missing_from_both')
    and email_status = 'public_email_found'
    and confidence >= 0.65
  );

alter table public.research_candidates
  alter column crm_comparison
    set default 'conflicting_multiple_matches',
  drop constraint if exists research_candidates_crm_comparison_check,
  add constraint research_candidates_crm_comparison_check
    check (
      crm_comparison in (
        'already_in_attio',
        'pipedrive_only',
        'missing_from_both',
        'conflicting_multiple_matches',
        'unverifiable_no_email'
      )
    ),
  drop constraint if exists research_candidates_email_status_check,
  add constraint research_candidates_email_status_check
    check (
      email_status in (
        'public_email_found',
        'not_publicly_found'
      )
    ),
  drop constraint if exists research_candidates_approval_eligibility_check,
  add constraint research_candidates_approval_eligibility_check
    check (
      review_status <> 'approved'
      or (
        crm_comparison in ('pipedrive_only', 'missing_from_both')
        and email_status = 'public_email_found'
        and confidence >= 0.65
      )
    );

-- A later worker retry may legitimately discover that an approved row now has
-- a conflicting/stale comparison. Demote it atomically so a future handoff
-- cannot observe an approval that no longer satisfies the gate.
create or replace function public.recheck_research_candidate_approval()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.review_status = 'approved'
    and new.review_status = 'approved'
    and not (
      new.crm_comparison in ('pipedrive_only', 'missing_from_both')
      and new.email_status = 'public_email_found'
      and new.confidence >= 0.65
    )
  then
    new.review_status := 'pending';
    new.reviewed_by := null;
    new.reviewed_at := null;
    new.updated_by := null;
    new.updated_at := now();
  end if;
  return new;
end;
$$;

revoke all on function public.recheck_research_candidate_approval()
  from public, anon, authenticated;

drop trigger if exists recheck_research_candidate_approval
  on public.research_candidates;

create trigger recheck_research_candidate_approval
before update of crm_comparison, email_status, confidence, review_status
on public.research_candidates
for each row
execute function public.recheck_research_candidate_approval();
