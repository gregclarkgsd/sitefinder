# Anon lockdown, 25 Oct 2026

Migration: `supabase/migrations/20261025110000_lock_down_anon_access.sql`
Tests: `supabase/tests/database/anon_lockdown.test.sql`
Status: **not applied live.** Read live state on 25 Oct 2026 (catalog queries only).

Repo usage check: `src/` reads only ccs_sync_runs, lead_tracking, outreach_*, project_notes, project_tasks,
research_*, saved_projects (signed-in, GSD email policies). `server.js` reads `ccs_project_schedule`
with the publishable (anon) key and no session. Edge functions use the service role for writes. Nothing in
the repo references `_p3_*`, the legacy tables or the `v_*` views.

| Table / view | Current access | New access | Why | Who uses it |
|---|---|---|---|---|
| _p3_batch_scratch, _p3_co7, _p3_hist_scratch, _p3_send_batch | RLS **off**; anon + authenticated ALL | RLS on, no policies; anon + authenticated none; service_role unchanged | Lead emails/names readable and writable by anyone with the public key | Phase 3 send scripts (not in repo). **Open: The Outlander to confirm still in use and which key** |
| agent_definitions, agent_tasks | anon ALL grant + `anon_read_*` SELECT using true | anon none | Not used by repo | Unknown / legacy |
| applications, clients, communications, compliance, contacts, documents, invoices, projects, variations, workforce | anon ALL grant + `anon_read_*` SELECT using true | anon none | Commercial/personal data public; not used by repo | Unknown / legacy (looks like an older SubOps-style schema) |
| ccs_project_schedule | anon ALL grant; SELECT policy for anon/authenticated | anon SELECT only | server.js reads it signed-out | server.js `projectSchedules()` |
| v_aged_by_contractor, v_commercial_opportunities, v_profitability_dashboard, v_programme_risks, v_relationship_health | anon ALL; postgres-owned, not security_invoker (bypass RLS) | anon none | Would leak the legacy tables to anon after the change | Unknown |

Unchanged: authenticated grants on legacy tables and views (follow-up: views still bypass RLS for any signed-in user).
