alter table public.outreach_leads
  add column if not exists send_claimed_at timestamptz,
  add column if not exists send_error text;

alter table public.outreach_leads
  drop constraint if exists outreach_leads_status_check;

alter table public.outreach_leads
  add constraint outreach_leads_status_check
  check (status in (
    'queued','reviewing','approved','sending','sent','followup_due','skipped',
    'replied','bounced','failed','suppressed','reconciliation_required'
  ));

create index if not exists outreach_leads_send_reconciliation_idx
  on public.outreach_leads(send_claimed_at)
  where status in ('sending','reconciliation_required');

comment on column public.outreach_leads.send_claimed_at is
  'Durable timestamp set before Gmail is called. A sending row is never automatically retried.';

comment on column public.outreach_leads.send_error is
  'Latest send or persistence failure requiring retry or manual Gmail reconciliation.';
