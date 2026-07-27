create table public.attio_sync_links (
  id bigint generated always as identity primary key,
  entity_type text not null
    check (entity_type in ('project', 'company', 'person', 'deal')),
  source_key text not null,
  source_name text,
  project_id text references public.ccs_projects(project_id) on delete cascade,
  attio_object_slug text not null,
  attio_record_id text,
  attio_web_url text,
  sitefinder_url text,
  source_hash text,
  sync_status text not null default 'pending'
    check (sync_status in ('pending', 'syncing', 'synced', 'error')),
  sync_error text,
  last_attempted_at timestamptz,
  synced_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (entity_type, source_key)
);

create index attio_sync_links_project_idx
  on public.attio_sync_links(project_id, entity_type);
create index attio_sync_links_record_idx
  on public.attio_sync_links(attio_object_slug, attio_record_id)
  where attio_record_id is not null;
create index attio_sync_links_pending_idx
  on public.attio_sync_links(sync_status, updated_at)
  where sync_status <> 'synced';

create table public.ccs_project_enrichment (
  project_id text primary key references public.ccs_projects(project_id) on delete cascade,
  programme_stage text not null default 'unknown'
    check (programme_stage in ('early', 'mid', 'late', 'closed', 'unknown')),
  gsd_timing text not null default 'unknown'
    check (gsd_timing in (
      'completing_0_3m',
      'decorating_3_9m',
      'monitor_9_18m',
      'early_over_18m',
      'overdue',
      'unknown'
    )),
  months_remaining integer,
  map_url text,
  ccs_rating text,
  complaints_count integer,
  registration_count integer,
  has_alerts boolean,
  has_news boolean,
  is_ultra_site boolean,
  sector text,
  work_type text,
  fit_out_state text not null default 'unknown'
    check (fit_out_state in ('yes', 'no', 'unknown')),
  new_build_housing_state text not null default 'unknown'
    check (new_build_housing_state in ('yes', 'no', 'unknown')),
  classification_confidence numeric(4,3)
    check (classification_confidence between 0 and 1),
  classification_evidence text[] not null default '{}',
  classification_sources jsonb not null default '[]'::jsonb,
  classification_method text,
  researched_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index ccs_project_enrichment_timing_idx
  on public.ccs_project_enrichment(gsd_timing, programme_stage);
create index ccs_project_enrichment_classification_idx
  on public.ccs_project_enrichment(sector, work_type)
  where sector is not null or work_type is not null;

alter table public.outreach_leads
  add column if not exists attio_web_url text,
  add column if not exists attio_project_record_id text,
  add column if not exists attio_project_url text;

insert into public.ccs_project_enrichment (
  project_id,
  programme_stage,
  gsd_timing,
  months_remaining,
  map_url,
  ccs_rating,
  complaints_count,
  registration_count,
  has_alerts,
  has_news,
  is_ultra_site,
  classification_method,
  updated_at
)
select
  project_id,
  case
    when site_closed is true or site_end_date < current_date then 'closed'
    when site_start_date is null or site_end_date is null or site_end_date <= site_start_date then 'unknown'
    when current_date <= site_start_date then 'early'
    when current_date >= site_end_date then 'closed'
    when (current_date - site_start_date)::numeric / nullif(site_end_date - site_start_date, 0) < 0.33 then 'early'
    when (current_date - site_start_date)::numeric / nullif(site_end_date - site_start_date, 0) < 0.67 then 'mid'
    else 'late'
  end,
  case
    when site_end_date is null then 'unknown'
    when site_end_date < current_date then 'overdue'
    when site_end_date <= current_date + interval '3 months' then 'completing_0_3m'
    when site_end_date <= current_date + interval '9 months' then 'decorating_3_9m'
    when site_end_date <= current_date + interval '18 months' then 'monitor_9_18m'
    else 'early_over_18m'
  end,
  case
    when site_end_date is null then null
    else round((site_end_date - current_date)::numeric / 30.4375)::integer
  end,
  case
    when latitude is null or longitude is null then null
    else 'https://www.google.com/maps/search/?api=1&query='
      || latitude::text || ',' || longitude::text
  end,
  nullif(detail_data ->> 'PerformanceLevel', ''),
  case
    when coalesce(detail_data ->> 'NumberOfComplaints', '') ~ '^[0-9]+$'
      then (detail_data ->> 'NumberOfComplaints')::integer
    else null
  end,
  case
    when jsonb_typeof(detail_data -> 'AllRegistrations') = 'array'
      then jsonb_array_length(detail_data -> 'AllRegistrations')
    else null
  end,
  lower(coalesce(detail_data ->> 'Alerts', 'false')) = 'true',
  lower(coalesce(detail_data ->> 'News', 'false')) = 'true',
  lower(coalesce(detail_data ->> 'UltraSite', source_data ->> 'UltraSite', 'false')) = 'true',
  'ccs_deterministic_v1',
  now()
from public.ccs_projects
on conflict (project_id) do update set
  programme_stage = excluded.programme_stage,
  gsd_timing = excluded.gsd_timing,
  months_remaining = excluded.months_remaining,
  map_url = excluded.map_url,
  ccs_rating = excluded.ccs_rating,
  complaints_count = excluded.complaints_count,
  registration_count = excluded.registration_count,
  has_alerts = excluded.has_alerts,
  has_news = excluded.has_news,
  is_ultra_site = excluded.is_ultra_site,
  updated_at = excluded.updated_at;

alter table public.attio_sync_links enable row level security;
alter table public.ccs_project_enrichment enable row level security;

revoke all on public.attio_sync_links from public, anon, authenticated;
revoke all on public.ccs_project_enrichment from public, anon, authenticated;
grant select on public.attio_sync_links to authenticated;
grant select on public.ccs_project_enrichment to authenticated;

create policy "GSD employees read Attio links"
on public.attio_sync_links for select to authenticated
using (lower(coalesce((select auth.jwt()) ->> 'email', '')) like '%@gsdecorating.com');

create policy "GSD employees read CCS enrichment"
on public.ccs_project_enrichment for select to authenticated
using (lower(coalesce((select auth.jwt()) ->> 'email', '')) like '%@gsdecorating.com');
