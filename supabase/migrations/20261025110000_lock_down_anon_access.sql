-- Lock down anon access in the Site Finder database (oihmehqrwdvajzyxvuhz).
-- NOT APPLIED LIVE. Do not apply until Greg says yes. Idempotent: safe to re-run.
-- See docs/security/anon-lockdown-2026-10-25.md for the per-table reasoning.

-- (a) Phase 3 scratch tables: RLS on, no policies, anon + authenticated revoked.
--     Only service_role (bypasses RLS) and postgres keep access.
do $$
declare t text;
begin
  foreach t in array array['_p3_batch_scratch','_p3_co7','_p3_hist_scratch','_p3_send_batch'] loop
    if to_regclass('public.' || t) is not null then
      execute format('alter table public.%I enable row level security', t);
      execute format('revoke all on table public.%I from anon, authenticated', t);
    end if;
  end loop;
end $$;

-- (b) Legacy tables with "anon_read_*" policies and full anon grants.
--     No code in this repo reads them; drop anon policies and grants.
--     authenticated grants are left as-is (no authenticated policies exist, so RLS already denies).
do $$
declare t text;
begin
  foreach t in array array['agent_definitions','agent_tasks','applications','clients','communications',
                           'compliance','contacts','documents','invoices','projects','variations','workforce'] loop
    if to_regclass('public.' || t) is not null then
      execute format('drop policy if exists %I on public.%I', 'anon_read_' || t, t);
      execute format('revoke all on table public.%I from anon', t);
    end if;
  end loop;
end $$;

-- ccs_project_schedule: server.js projectSchedules() reads it with the publishable
-- (anon) key and no user session, so anon SELECT stays. Remove anon writes only.
-- The "Public CCS schedule is readable" SELECT policy is kept unchanged.
do $$
begin
  if to_regclass('public.ccs_project_schedule') is not null then
    revoke insert, update, delete, truncate, references, trigger on table public.ccs_project_schedule from anon;
    grant select on table public.ccs_project_schedule to anon;
  end if;
end $$;

-- Views owned by postgres without security_invoker bypass RLS on the tables above,
-- so anon could read applications/invoices/etc. through them. Revoke anon.
do $$
declare v text;
begin
  foreach v in array array['v_aged_by_contractor','v_commercial_opportunities','v_profitability_dashboard',
                           'v_programme_risks','v_relationship_health'] loop
    if to_regclass('public.' || v) is not null then
      execute format('revoke all on table public.%I from anon', v);
    end if;
  end loop;
end $$;

-- ROLLBACK (manual, only if something breaks; restores the 25 Oct 2026 state):
-- do $$ declare t text; begin
--   foreach t in array array['_p3_batch_scratch','_p3_co7','_p3_hist_scratch','_p3_send_batch'] loop
--     execute format('alter table public.%I disable row level security', t);
--     execute format('grant all on table public.%I to anon, authenticated', t);
--   end loop;
--   foreach t in array array['agent_definitions','agent_tasks','applications','clients','communications',
--                            'compliance','contacts','documents','invoices','projects','variations','workforce'] loop
--     execute format('grant all on table public.%I to anon', t);
--     execute format('create policy %I on public.%I for select to anon using (true)', 'anon_read_' || t, t);
--   end loop;
--   grant all on table public.ccs_project_schedule to anon;
--   foreach t in array array['v_aged_by_contractor','v_commercial_opportunities','v_profitability_dashboard',
--                            'v_programme_risks','v_relationship_health'] loop
--     execute format('grant all on table public.%I to anon', t);
--   end loop;
-- end $$;
