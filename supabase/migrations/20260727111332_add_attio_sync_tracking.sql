alter table public.outreach_leads
  add column if not exists attio_synced_at timestamptz,
  add column if not exists attio_sync_error text;

create index if not exists outreach_leads_attio_pending_idx
  on public.outreach_leads(status, approved_at)
  where status in ('approved', 'sent', 'replied')
    and attio_record_id is null;
