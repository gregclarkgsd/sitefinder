-- Production applied this version with two cron.schedule() calls
-- ('process-scheduled-initial-outreach' and 'process-outreach-followups-hourly')
-- that post to the production function URL with a Vault-held secret.
--
-- The repository keeps this version so the local and remote migration ledgers
-- line up, but it schedules nothing: cron jobs and their credentials are
-- installed operationally (see docs/OPERATIONAL-CRON-JOBS.md). A local or
-- branch database reset must never schedule jobs that call production or send
-- email.
select 1;
