# Operational cron jobs (SiteFinder)

Cron jobs and their credentials are installed by hand on the production
project, never by a migration. A local or branch `supabase db reset` must not
schedule anything that calls production, sends email or writes to a CRM.

This page records what production has, so the repository is an honest mirror.
**Do not run any of these commands without explicit approval.**

## Current production jobs (read 25 Oct 2026, `cron.job`)

| jobid | jobname | schedule (UTC) | active | calls | auth |
| --- | --- | --- | --- | --- | --- |
| 1 | `nightly-ccs-project-sync` | `0 2 * * *` | yes | `sync-ccs-projects` | Vault secret |
| 4 | `renew-gmail-watches-daily` | `15 3 * * *` | yes | `renew-gmail-watches` | Vault `outreach_cron_secret` |

## Jobs created by migrations that are no longer scheduled

Two production migrations scheduled jobs directly. In the repository those two
files are kept as no-ops (`select 1;`) so the migration ledgers line up:

| Migration | Jobs it scheduled | In `cron.job` today |
| --- | --- | --- |
| `20260816111759_schedule_outreach_watch_and_followups` | `renew-gmail-watches-daily` (`15 3 * * *`), `process-outreach-followups` (`*/15 * * * *`) | only `renew-gmail-watches-daily` |
| `20260816175256_schedule_initial_outreach` | `process-scheduled-initial-outreach` (`10 8-17 * * 1-5`), `process-outreach-followups-hourly` (`25 8-17 * * 1-5`) | neither |

The outreach jobs were unscheduled out of band after those migrations ran.

## Command shape (for an approved reinstall only)

Every job posts to an Edge Function with a secret read from Vault at run time.
Never write a secret inline.

```sql
select cron.schedule(
  '<job-name>',
  '<schedule>',
  $$
  select net.http_post(
    url := 'https://<project-ref>.supabase.co/functions/v1/<function-slug>',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-sitefinder-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = '<vault-secret-name>')
    ),
    body := '{}'::jsonb
  );
  $$
);
```
