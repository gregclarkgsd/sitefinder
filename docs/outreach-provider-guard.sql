-- LOCAL TEST / REVIEW ONLY. Not an automatic migration. No production execution.
begin;
create schema if not exists private;
create table private.outreach_provider_claims (
  project_id text primary key,
  outreach_lead_id uuid not null unique,
  recipient_email text not null unique check (recipient_email = lower(trim(recipient_email)) and recipient_email <> ''),
  company_key text not null unique check (company_key like 'attio:%'),
  provider text not null check (provider in ('gmail','lemlist','woodpecker')),
  claimed_at timestamptz not null default clock_timestamp()
  -- No deletion cascades or release: uncertain outcomes retain their reservation.
);
create table private.outreach_provider_checks (
  outreach_lead_id uuid primary key,
  recipient_email text not null,
  company_key text not null,
  owner_email text not null,
  provider text not null check (provider in ('gmail','lemlist')),
  checked_at timestamptz not null,
  all_sources_complete boolean not null default false,
  suppression_clear boolean not null default false,
  ownership_clear boolean not null default false,
  history_clear boolean not null default false
);
alter table private.outreach_provider_claims enable row level security;
alter table private.outreach_provider_checks enable row level security;
revoke all on private.outreach_provider_claims, private.outreach_provider_checks from public, anon, authenticated;
create function private.preserve_provider_claim()
returns trigger language plpgsql set search_path = '' as $$
begin raise exception 'Provider reservations require manual reconciliation and cannot be erased'; end;
$$;
create trigger immutable_provider_claim before update or delete on private.outreach_provider_claims
for each row execute function private.preserve_provider_claim();
revoke all on function private.preserve_provider_claim() from public, anon, authenticated;

create function public.claim_outreach_provider(requested_lead uuid, requested_provider text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  lead public.outreach_leads;
  checks private.outreach_provider_checks;
  existing private.outreach_provider_claims;
  recipient text;
  company text;
begin
  if requested_provider not in ('gmail','lemlist') or requested_provider is null then
    raise exception 'Unknown provider';
  end if;
  select * into lead from public.outreach_leads where id = requested_lead for update;
  if not found then raise exception 'Unknown lead'; end if;
  recipient := lower(trim(lead.recipient_email));
  company := 'attio:' || lower(lead.attio_company_record_id);
  if recipient is null or recipient = '' or company is null then raise exception 'Missing identity'; end if;
  select * into checks from private.outreach_provider_checks where outreach_lead_id = lead.id;
  if not found or not checks.all_sources_complete or not checks.suppression_clear
     or not checks.ownership_clear or not checks.history_clear
     or checks.checked_at > clock_timestamp() or checks.checked_at < clock_timestamp() - interval '15 minutes'
     or checks.recipient_email is distinct from recipient or checks.company_key is distinct from company
     or checks.provider is distinct from requested_provider
     or checks.owner_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then
    raise exception 'Missing fresh cross-provider checks';
  end if;
  if not exists (select 1 from public.lead_tracking t where t.project_id = lead.project_id
       and lower(trim(t.assigned_email)) = checks.owner_email and t.stage in ('new','contacted'))
     or (requested_provider = 'gmail' and lower(trim(lead.sender_email)) is distinct from checks.owner_email)
     or exists (select 1 from public.outreach_suppressions where email = recipient)
     or lead.status in ('suppressed','bounced','replied','skipped','reconciliation_required')
     or lead.last_reply_at is not null or lead.last_bounce_at is not null or lead.last_unsubscribe_at is not null then
    raise exception 'Ownership, suppression or reply hold';
  end if;
  if requested_provider = 'lemlist' and (lead.status not in ('queued','reviewing')
      or lead.gmail_message_id is not null or lead.sent_at is not null
      or lead.send_claimed_at is not null or lead.next_follow_up_at is not null) then
    raise exception 'Gmail activity blocks Lemlist';
  end if;
  if exists (select 1 from public.outreach_leads other where other.id <> lead.id
      and (other.project_id = lead.project_id or lower(trim(other.recipient_email)) = recipient
      or lower(other.attio_company_record_id) = lower(lead.attio_company_record_id))) then
    raise exception 'Related outreach requires consolidation';
  end if;
  select * into existing from private.outreach_provider_claims where project_id = lead.project_id;
  if found then
    if existing.outreach_lead_id is distinct from lead.id or existing.recipient_email is distinct from recipient
       or existing.company_key is distinct from company or existing.provider is distinct from requested_provider then
      raise exception 'Provider or identity reservation conflict';
    end if;
    return jsonb_build_object('allowed', true, 'reused', true);
  end if;
  -- Unique constraints arbitrate concurrent requests for different leads sharing
  -- email/company. A losing transaction raises; no check-then-send race.
  insert into private.outreach_provider_claims(project_id,outreach_lead_id,recipient_email,company_key,provider)
  values(lead.project_id,lead.id,recipient,company,requested_provider);
  return jsonb_build_object('allowed', true, 'reused', false);
end;
$$;
revoke all on function public.claim_outreach_provider(uuid,text) from public, anon, authenticated;
grant execute on function public.claim_outreach_provider(uuid,text) to service_role;
commit;
