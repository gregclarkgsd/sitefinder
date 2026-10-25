-- Shared UK public procurement notices from Find a Tender (fts) and
-- Contracts Finder (cf). Notices are public OGL data stored once, keyed on the
-- OCDS ocid, and written only by the service role through
-- public.ingest_tender_notices(). Tenant-specific scoring lives elsewhere.

create extension if not exists pg_trgm with schema extensions;

create table public.tender_sources (
  code text primary key check (code in ('fts', 'cf')),
  label text not null,
  base_url text not null
);

insert into public.tender_sources (code, label, base_url) values
  ('fts', 'Find a Tender', 'https://www.find-tender.service.gov.uk'),
  ('cf', 'Contracts Finder', 'https://www.contractsfinder.service.gov.uk');

create table public.tender_notices (
  ocid text primary key check (length(ocid) between 1 and 200),
  source text not null references public.tender_sources(code),
  release_id text not null,
  stage text check (stage in ('planning', 'tender', 'award', 'contract')),
  tender_status text,
  title text,
  description text,
  buyer_name text,
  buyer_id text,
  cpv_codes text[] not null default '{}',
  regions text[] not null default '{}',
  postcodes text[] not null default '{}',
  value_amount numeric check (value_amount is null or value_amount >= 0),
  value_currency text,
  tender_deadline timestamptz,
  contract_start date,
  contract_end date,
  award_suppliers jsonb not null default '[]'::jsonb,
  notice_url text,
  is_framework_or_dps boolean not null default false,
  published_at timestamptz,
  source_updated_at timestamptz,
  raw jsonb not null,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  unique (source, release_id)
);

create index tender_notices_cpv_codes_idx on public.tender_notices using gin (cpv_codes);
create index tender_notices_title_trgm_idx on public.tender_notices using gin (title gin_trgm_ops);
create index tender_notices_tender_deadline_idx on public.tender_notices (tender_deadline);
create index tender_notices_contract_end_idx on public.tender_notices (contract_end);
create index tender_notices_source_updated_at_idx on public.tender_notices (source_updated_at);

-- Every release seen for a notice, from either feed, so a notice mirrored in
-- both feeds is stored once with both release ids.
create table public.tender_notice_releases (
  source text not null references public.tender_sources(code),
  release_id text not null,
  ocid text not null references public.tender_notices(ocid) on delete cascade,
  source_updated_at timestamptz,
  first_seen_at timestamptz not null default now(),
  primary key (source, release_id)
);

create index tender_notice_releases_ocid_idx on public.tender_notice_releases (ocid);

-- One row per pull attempt. 'running' rows that never finish show a crash;
-- 'skipped' is an intentional no-op (outside the schedule window).
create table public.tender_pull_runs (
  id uuid primary key default gen_random_uuid(),
  source text not null references public.tender_sources(code),
  mode text not null default 'scheduled' check (mode in ('scheduled', 'manual', 'backfill')),
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  status text not null default 'running'
    check (status in ('running', 'ok', 'empty', 'failed', 'partial', 'skipped')),
  window_from timestamptz,
  window_to timestamptz,
  pages int not null default 0 check (pages >= 0),
  fetched int not null default 0 check (fetched >= 0),
  upserted int not null default 0 check (upserted >= 0),
  http_status int,
  next_cursor text,
  error text,
  check (finished_at is null or finished_at >= started_at),
  check (status = 'running' or finished_at is not null),
  check (window_to is null or window_from is null or window_to >= window_from)
);

create index tender_pull_runs_source_started_idx on public.tender_pull_runs (source, started_at desc);

-- Upserts a batch of normalised notices (one JSON object per release, keys
-- named after tender_notices columns). A notice is replaced only when the
-- incoming release is newer; re-running the same window changes nothing.
-- Returns counts and the ocids whose content changed, for re-scoring.
create function public.ingest_tender_notices(notices jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  inserted_count int;
  updated_count int;
  releases_count int;
  touched text[];
begin
  if jsonb_typeof(notices) is distinct from 'array' then
    raise exception 'notices must be a JSON array' using errcode = '22023';
  end if;

  if exists (
    select 1 from jsonb_populate_recordset(null::public.tender_notices, notices)
    where ocid is null or source is null or release_id is null or raw is null
  ) then
    raise exception 'every notice needs ocid, source, release_id and raw' using errcode = '23502';
  end if;

  with incoming as (
    select * from jsonb_populate_recordset(null::public.tender_notices, notices)
  ),
  newest as (
    select distinct on (ocid) *
    from incoming
    order by ocid, source_updated_at desc nulls last, source, release_id
  ),
  upserted as (
    insert into public.tender_notices as n (
      ocid, source, release_id, stage, tender_status, title, description,
      buyer_name, buyer_id, cpv_codes, regions, postcodes, value_amount,
      value_currency, tender_deadline, contract_start, contract_end,
      award_suppliers, notice_url, is_framework_or_dps, published_at,
      source_updated_at, raw
    )
    select
      ocid, source, release_id, stage, tender_status, title, description,
      buyer_name, buyer_id, coalesce(cpv_codes, '{}'), coalesce(regions, '{}'),
      coalesce(postcodes, '{}'), value_amount, value_currency, tender_deadline,
      contract_start, contract_end, coalesce(award_suppliers, '[]'::jsonb),
      notice_url, coalesce(is_framework_or_dps, false), published_at,
      source_updated_at, raw
    from newest
    on conflict (ocid) do update set
      source = excluded.source,
      release_id = excluded.release_id,
      stage = excluded.stage,
      tender_status = excluded.tender_status,
      title = excluded.title,
      description = excluded.description,
      buyer_name = excluded.buyer_name,
      buyer_id = excluded.buyer_id,
      cpv_codes = excluded.cpv_codes,
      regions = excluded.regions,
      postcodes = excluded.postcodes,
      value_amount = excluded.value_amount,
      value_currency = excluded.value_currency,
      tender_deadline = excluded.tender_deadline,
      contract_start = excluded.contract_start,
      contract_end = excluded.contract_end,
      award_suppliers = excluded.award_suppliers,
      notice_url = excluded.notice_url,
      is_framework_or_dps = excluded.is_framework_or_dps,
      published_at = excluded.published_at,
      source_updated_at = excluded.source_updated_at,
      raw = excluded.raw,
      last_seen_at = now()
    where excluded.source_updated_at is not null
      and (n.source_updated_at is null or excluded.source_updated_at > n.source_updated_at)
    returning n.ocid, (xmax = 0) as was_inserted
  )
  select
    count(*) filter (where was_inserted),
    count(*) filter (where not was_inserted),
    coalesce(array_agg(ocid order by ocid), '{}')
  into inserted_count, updated_count, touched
  from upserted;

  with incoming as (
    select * from jsonb_populate_recordset(null::public.tender_notices, notices)
  ),
  releases as (
    insert into public.tender_notice_releases (source, release_id, ocid, source_updated_at)
    select distinct on (source, release_id) source, release_id, ocid, source_updated_at
    from incoming
    order by source, release_id, source_updated_at desc nulls last
    on conflict (source, release_id) do nothing
    returning 1
  )
  select count(*) into releases_count from releases;

  return jsonb_build_object(
    'received', jsonb_array_length(notices),
    'inserted', inserted_count,
    'updated', updated_count,
    'releases_added', releases_count,
    'touched_ocids', to_jsonb(touched)
  );
end;
$$;

revoke all on function public.ingest_tender_notices(jsonb) from public, anon, authenticated;
grant execute on function public.ingest_tender_notices(jsonb) to service_role;

alter table public.tender_sources enable row level security;
alter table public.tender_notices enable row level security;
alter table public.tender_notice_releases enable row level security;
alter table public.tender_pull_runs enable row level security;

revoke all on public.tender_sources, public.tender_notices, public.tender_notice_releases, public.tender_pull_runs
from public, anon, authenticated;
grant select on public.tender_sources, public.tender_notices, public.tender_notice_releases, public.tender_pull_runs
to authenticated;
grant all on public.tender_sources, public.tender_notices, public.tender_notice_releases, public.tender_pull_runs
to service_role;

create policy "Signed-in users read tender sources"
on public.tender_sources for select to authenticated using (true);
create policy "Signed-in users read tender notices"
on public.tender_notices for select to authenticated using (true);
create policy "Signed-in users read tender notice releases"
on public.tender_notice_releases for select to authenticated using (true);
create policy "Signed-in users read tender pull runs"
on public.tender_pull_runs for select to authenticated using (true);
