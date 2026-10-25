-- Production applied this version with two cron.schedule() calls
-- ('renew-gmail-watches-daily' and 'process-outreach-followups') that post to
-- the production function URL with a Vault-held secret.
--
-- The repository keeps this version so the local and remote migration ledgers
-- line up, but it schedules nothing: cron jobs and their credentials are
-- installed operationally (see docs/OPERATIONAL-CRON-JOBS.md), matching
-- 20260716155451_enable_nightly_ccs_sync. A local or branch database reset must
-- never schedule jobs that call production.
select 1;
