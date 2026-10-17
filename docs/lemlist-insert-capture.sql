-- DESIGN / LOCAL-TEST SCRIPT ONLY. Not an automatic Supabase migration.
-- Do not apply to production without a separate reviewed deployment approval.
-- No network calls, campaign enrollment, credential storage or Gmail changes.
begin;
create schema if not exists private;

create table private.lemlist_review_boundary (
  singleton boolean primary key default true check (singleton),
  capture_id uuid not null unique default gen_random_uuid(),
  campaign_id text not null check (length(trim(campaign_id)) > 0),
  go_live_at timestamptz not null,
  initialized_at timestamptz not null default clock_timestamp()
);
create table private.lemlist_excluded_projects (
  project_id text primary key -- Deliberately no FK: preserve exclusions after deletion/reimport.
);
create table private.lemlist_insert_events (
  id uuid primary key default gen_random_uuid(),
  capture_id uuid not null,
  project_id text not null unique, -- Keep first insert even after deletion/reimport.
  captured_at timestamptz not null default clock_timestamp(),
  project jsonb not null
);

create function private.capture_lemlist_project_insert()
returns trigger language plpgsql security definer set search_path = '' as $$
declare boundary private.lemlist_review_boundary;
begin
  select * into boundary from private.lemlist_review_boundary where singleton;
  if found then
    insert into private.lemlist_insert_events(capture_id, project_id, project)
    values (boundary.capture_id, new.project_id, to_jsonb(new))
    on conflict (project_id) do nothing;
  end if;
  return new;
end;
$$;

create trigger capture_lemlist_project_insert
after insert on public.ccs_projects
for each row execute function private.capture_lemlist_project_insert();

-- Run explicitly once, before a future cutoff, by an approved database operator.
-- The table lock ensures no project insert can fall between snapshot and capture
-- activation. Rows inserted before the cutoff are still filtered by first_seen_at.
create function private.initialize_lemlist_review(campaign text, go_live timestamptz)
returns uuid language plpgsql security definer set search_path = '' as $$
declare capture uuid;
begin
  lock table public.ccs_projects in share row exclusive mode;
  if go_live is null or go_live <= clock_timestamp() then
    raise exception 'Future go-live timestamp required';
  end if;
  insert into private.lemlist_review_boundary(campaign_id, go_live_at)
  values(campaign, go_live) returning capture_id into capture;
  insert into private.lemlist_excluded_projects(project_id)
  select project_id from public.ccs_projects;
  return capture;
end;
$$;

-- Append-only audit records; changing the go-live boundary is not an update path.
create function private.reject_lemlist_history_change()
returns trigger language plpgsql set search_path = '' as $$
begin
  raise exception 'Lemlist review history is immutable';
end;
$$;
create trigger immutable_lemlist_boundary before update or delete on private.lemlist_review_boundary
for each row execute function private.reject_lemlist_history_change();
create trigger immutable_lemlist_exclusions before update or delete on private.lemlist_excluded_projects
for each row execute function private.reject_lemlist_history_change();
create trigger immutable_lemlist_events before update or delete on private.lemlist_insert_events
for each row execute function private.reject_lemlist_history_change();

alter table private.lemlist_review_boundary enable row level security;
alter table private.lemlist_excluded_projects enable row level security;
alter table private.lemlist_insert_events enable row level security;
revoke all on private.lemlist_review_boundary, private.lemlist_excluded_projects, private.lemlist_insert_events from public, anon, authenticated;
revoke all on function private.initialize_lemlist_review(text, timestamptz) from public, anon, authenticated;
revoke all on function private.capture_lemlist_project_insert() from public, anon, authenticated;
revoke all on function private.reject_lemlist_history_change() from public, anon, authenticated;
commit;
