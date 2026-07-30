-- Distinguish licensed-provider business emails from public-source emails.
-- Licensed emails remain ineligible for approval until independently verified.

alter table public.research_candidates
  drop constraint if exists research_candidates_email_status_check,
  add constraint research_candidates_email_status_check
    check (
      email_status in (
        'public_email_found',
        'licensed_business_email_found',
        'not_publicly_found'
      )
    );
