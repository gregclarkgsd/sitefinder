-- Per-tenant tender matching settings and scored leads. Defaults are a
-- neutral template; every keyword, CPV code, region and buyer list starts
-- empty and is set by each tenant's admins.

create table public.tender_tenant_settings (
  tenant_id uuid primary key references public.tenants(id) on delete cascade,
  keywords text[] not null default '{}',
  negative_keywords text[] not null default '{}',
  cpv_primary text[] not null default '{}',
  cpv_secondary text[] not null default '{}',
  regions text[] not null default '{}',
  buyer_allow text[] not null default '{}',
  buyer_block text[] not null default '{}',
  min_value numeric check (min_value is null or min_value >= 0),
  max_value numeric check (max_value is null or max_value >= 0),
  weights jsonb not null default '{
    "cpv_primary": 40,
    "cpv_secondary": 15,
    "keyword_title": 25,
    "keyword_description": 10,
    "region_or_buyer_allow": 20,
    "buyer_type": 10,
    "stage_tender": 10,
    "stage_planning": 5,
    "negative_keyword": -50,
    "value_outside_band": -20
  }'::jsonb check (jsonb_typeof(weights) = 'object'),
  min_score_to_show int not null default 40 check (min_score_to_show between 0 and 100),
  digest_enabled boolean not null default false,
  stages jsonb not null default '{
    "to_qualify": "To qualify",
    "qualifying": "Qualifying",
    "bid_no_bid": "Bid / no-bid",
    "bidding": "Bidding",
    "submitted": "Submitted",
    "won": "Won",
    "lost": "Lost",
    "dismissed": "Dismissed"
  }'::jsonb check (jsonb_typeof(stages) = 'object'),
  settings_version int not null default 1,
  updated_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz not null default now(),
  check (min_value is null or max_value is null or min_value <= max_value)
);

create table public.tender_leads (
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  ocid text not null references public.tender_notices(ocid) on delete cascade,
  score int not null check (score between 0 and 100),
  score_breakdown jsonb not null,
  status text not null default 'to_qualify' check (status in (
    'to_qualify', 'qualifying', 'bid_no_bid', 'bidding',
    'submitted', 'won', 'lost', 'dismissed'
  )),
  dismiss_reason text check (dismiss_reason is null or length(dismiss_reason) <= 500),
  assigned_to uuid references auth.users(id) on delete set null,
  urgent boolean not null default false,
  scored_at timestamptz,
  settings_version int,
  updated_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz not null default now(),
  -- Stay null until a separately approved CRM push exists.
  crm_pushed_at timestamptz,
  crm_record_id text,
  primary key (tenant_id, ocid)
);

create index tender_leads_tenant_status_score_idx on public.tender_leads (tenant_id, status, score desc);
create index tender_leads_ocid_idx on public.tender_leads (ocid);

-- Saving settings bumps the version that scored leads record, so stale
-- scores can be found and re-scored.
create function private.bump_tender_settings_version()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  if (new.keywords, new.negative_keywords, new.cpv_primary, new.cpv_secondary,
      new.regions, new.buyer_allow, new.buyer_block, new.min_value, new.max_value,
      new.weights)
     is distinct from
     (old.keywords, old.negative_keywords, old.cpv_primary, old.cpv_secondary,
      old.regions, old.buyer_allow, old.buyer_block, old.min_value, old.max_value,
      old.weights) then
    new.settings_version := old.settings_version + 1;
  else
    new.settings_version := old.settings_version;
  end if;
  return new;
end;
$$;

create trigger bump_tender_settings_version
before update on public.tender_tenant_settings
for each row execute function private.bump_tender_settings_version();

-- A lead can only be assigned to someone in its tenant.
create function private.check_tender_lead_assignee()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.assigned_to is not null and not exists (
    select 1 from public.tenant_members m
    where m.tenant_id = new.tenant_id
      and m.user_id = new.assigned_to
      and m.role in ('admin', 'member')
  ) then
    raise exception 'tender leads can only be assigned to members of their tenant'
      using errcode = '23514';
  end if;
  if tg_op = 'UPDATE' then
    new.updated_at := now();
  end if;
  return new;
end;
$$;

revoke all on function private.bump_tender_settings_version() from public, anon, authenticated;
revoke all on function private.check_tender_lead_assignee() from public, anon, authenticated;

create trigger check_tender_lead_assignee
before insert or update on public.tender_leads
for each row execute function private.check_tender_lead_assignee();

alter table public.tender_tenant_settings enable row level security;
alter table public.tender_leads enable row level security;

revoke all on public.tender_tenant_settings, public.tender_leads from public, anon, authenticated;

grant select on public.tender_tenant_settings to authenticated;
grant insert (
  tenant_id, keywords, negative_keywords, cpv_primary, cpv_secondary, regions,
  buyer_allow, buyer_block, min_value, max_value, weights, min_score_to_show,
  digest_enabled, stages, updated_by
) on public.tender_tenant_settings to authenticated;
grant update (
  keywords, negative_keywords, cpv_primary, cpv_secondary, regions,
  buyer_allow, buyer_block, min_value, max_value, weights, min_score_to_show,
  digest_enabled, stages, updated_by
) on public.tender_tenant_settings to authenticated;

grant select on public.tender_leads to authenticated;
grant update (status, dismiss_reason, assigned_to, updated_by) on public.tender_leads to authenticated;

grant all on public.tender_tenant_settings, public.tender_leads to service_role;

create policy "Tenant members read tender settings"
on public.tender_tenant_settings for select to authenticated
using (public.is_tenant_member(tenant_id));

create policy "Tenant admins create tender settings"
on public.tender_tenant_settings for insert to authenticated
with check (public.is_tenant_member(tenant_id, 'admin') and updated_by = (select auth.uid()));

create policy "Tenant admins change tender settings"
on public.tender_tenant_settings for update to authenticated
using (public.is_tenant_member(tenant_id, 'admin'))
with check (public.is_tenant_member(tenant_id, 'admin') and updated_by = (select auth.uid()));

create policy "Tenant members read tender leads"
on public.tender_leads for select to authenticated
using (public.is_tenant_member(tenant_id));

create policy "Tenant members work tender leads"
on public.tender_leads for update to authenticated
using (public.is_tenant_member(tenant_id, 'member'))
with check (public.is_tenant_member(tenant_id, 'member') and updated_by = (select auth.uid()));
