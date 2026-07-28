create table public.livesites_import_runs (
  id uuid primary key default gen_random_uuid(),
  mode text not null default 'pilot'
    check (mode in ('pilot', 'bulk')),
  status text not null default 'validating'
    check (status in ('validating', 'validated', 'importing', 'completed', 'partial', 'error')),
  dry_run boolean not null default true,
  requested_count integer not null default 0 check (requested_count >= 0),
  validated_count integer not null default 0 check (validated_count >= 0),
  imported_count integer not null default 0 check (imported_count >= 0),
  matched_count integer not null default 0 check (matched_count >= 0),
  review_count integer not null default 0 check (review_count >= 0),
  unmatched_count integer not null default 0 check (unmatched_count >= 0),
  error_count integer not null default 0 check (error_count >= 0),
  requested_by uuid references auth.users(id) on delete set null,
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  created_at timestamptz not null default now()
);

create table public.livesites_projects (
  livesites_site_id text primary key
    check (length(trim(livesites_site_id)) > 0),
  source_url text not null unique
    check (source_url ~ '^https://(www\.)?livesites\.co\.uk/'),
  project_name text not null,
  project_type text,
  project_description text,
  live_status text,
  address text,
  postcode text,
  location text,
  local_authority text,
  contract_value_gbp numeric(14,2)
    check (contract_value_gbp is null or contract_value_gbp >= 0),
  unit_count integer
    check (unit_count is null or unit_count >= 0),
  unit_type text,
  main_contractor text,
  client text,
  site_start_date date,
  site_end_date date,
  trades_required text[] not null default '{}',
  painting_and_decorating_required boolean,
  image_url text
    check (image_url is null or image_url ~ '^https://'),
  latitude double precision,
  longitude double precision,
  is_viewed boolean,
  is_saved boolean,
  source_notes text,
  source_hash text not null,
  raw_data jsonb not null default '{}'::jsonb,
  first_imported_at timestamptz not null default now(),
  last_imported_at timestamptz not null default now(),
  source_verified_at timestamptz,
  updated_at timestamptz not null default now()
);

create index livesites_projects_postcode_idx
  on public.livesites_projects(postcode)
  where postcode is not null;
create index livesites_projects_contractor_idx
  on public.livesites_projects(lower(main_contractor))
  where main_contractor is not null;
create index livesites_projects_programme_idx
  on public.livesites_projects(site_end_date, site_start_date);
create index livesites_projects_painting_idx
  on public.livesites_projects(painting_and_decorating_required, site_end_date)
  where painting_and_decorating_required is true;
create index livesites_projects_trades_idx
  on public.livesites_projects using gin(trades_required);

create table public.livesites_contacts (
  id uuid primary key default gen_random_uuid(),
  livesites_site_id text not null
    references public.livesites_projects(livesites_site_id) on delete cascade,
  source_contact_key text not null,
  full_name text,
  job_title text,
  phone text,
  email text,
  email_verified boolean,
  company_name text,
  verified_at timestamptz,
  is_active boolean not null default true,
  raw_data jsonb not null default '{}'::jsonb,
  first_imported_at timestamptz not null default now(),
  last_imported_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (livesites_site_id, source_contact_key)
);

create index livesites_contacts_site_idx
  on public.livesites_contacts(livesites_site_id, is_active);
create index livesites_contacts_email_idx
  on public.livesites_contacts(lower(email))
  where email is not null;

create table public.livesites_project_matches (
  livesites_site_id text primary key
    references public.livesites_projects(livesites_site_id) on delete cascade,
  project_id text
    references public.ccs_projects(project_id) on delete cascade,
  match_status text not null
    check (match_status in ('auto_confirmed', 'confirmed', 'review', 'unmatched', 'rejected')),
  match_score numeric(5,4)
    check (match_score is null or match_score between 0 and 1),
  match_method text,
  match_evidence jsonb not null default '{}'::jsonb,
  source_conflicts text[] not null default '{}',
  reviewed_by uuid references auth.users(id) on delete set null,
  reviewed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index livesites_matches_project_idx
  on public.livesites_project_matches(project_id, match_status)
  where project_id is not null;
create index livesites_matches_review_idx
  on public.livesites_project_matches(match_status, match_score desc)
  where match_status in ('review', 'unmatched');
create unique index livesites_confirmed_project_unique
  on public.livesites_project_matches(project_id)
  where project_id is not null
    and match_status in ('auto_confirmed', 'confirmed');

alter table public.ccs_project_enrichment
  add column if not exists livesites_site_id text
    references public.livesites_projects(livesites_site_id) on delete set null,
  add column if not exists livesites_url text,
  add column if not exists livesites_live_status text,
  add column if not exists contract_value_gbp numeric(14,2)
    check (contract_value_gbp is null or contract_value_gbp >= 0),
  add column if not exists project_type text,
  add column if not exists livesites_project_description text,
  add column if not exists unit_count integer
    check (unit_count is null or unit_count >= 0),
  add column if not exists unit_type text,
  add column if not exists trades_required text[] not null default '{}',
  add column if not exists painting_and_decorating_required boolean,
  add column if not exists livesites_image_url text,
  add column if not exists livesites_contact_name text,
  add column if not exists livesites_contact_job_title text,
  add column if not exists livesites_contact_phone text,
  add column if not exists livesites_contact_email text,
  add column if not exists livesites_contact_email_verified boolean,
  add column if not exists livesites_verified_at timestamptz,
  add column if not exists source_conflicts text[] not null default '{}',
  add column if not exists livesites_previous_classification jsonb;

create index ccs_enrichment_painting_idx
  on public.ccs_project_enrichment(
    painting_and_decorating_required,
    gsd_timing,
    programme_stage
  )
  where painting_and_decorating_required is true;
create index ccs_enrichment_contract_value_idx
  on public.ccs_project_enrichment(contract_value_gbp desc)
  where contract_value_gbp is not null;

alter table public.livesites_import_runs enable row level security;
alter table public.livesites_projects enable row level security;
alter table public.livesites_contacts enable row level security;
alter table public.livesites_project_matches enable row level security;

revoke all on public.livesites_import_runs from public, anon, authenticated;
revoke all on public.livesites_projects from public, anon, authenticated;
revoke all on public.livesites_contacts from public, anon, authenticated;
revoke all on public.livesites_project_matches from public, anon, authenticated;

grant select on public.livesites_import_runs to authenticated;
grant select on public.livesites_projects to authenticated;
grant select on public.livesites_contacts to authenticated;
grant select on public.livesites_project_matches to authenticated;

create policy "GSD employees read LiveSites import runs"
on public.livesites_import_runs for select to authenticated
using (lower(coalesce((select auth.jwt()) ->> 'email', '')) like '%@gsdecorating.com');

create policy "GSD employees read LiveSites projects"
on public.livesites_projects for select to authenticated
using (lower(coalesce((select auth.jwt()) ->> 'email', '')) like '%@gsdecorating.com');

create policy "GSD employees read LiveSites contacts"
on public.livesites_contacts for select to authenticated
using (lower(coalesce((select auth.jwt()) ->> 'email', '')) like '%@gsdecorating.com');

create policy "GSD employees read LiveSites project matches"
on public.livesites_project_matches for select to authenticated
using (lower(coalesce((select auth.jwt()) ->> 'email', '')) like '%@gsdecorating.com');
