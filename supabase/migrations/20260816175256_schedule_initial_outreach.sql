select cron.schedule(
  'process-scheduled-initial-outreach',
  '10 8-17 * * 1-5',
  $$
  select net.http_post(
    url := 'https://oihmehqrwdvajzyxvuhz.supabase.co/functions/v1/process-scheduled-initial-outreach',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-sitefinder-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'outreach_cron_secret')
    ),
    body := '{}'::jsonb
  );
  $$
);

select cron.schedule(
  'process-outreach-followups-hourly',
  '25 8-17 * * 1-5',
  $$
  select net.http_post(
    url := 'https://oihmehqrwdvajzyxvuhz.supabase.co/functions/v1/process-outreach-followups',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-sitefinder-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'outreach_cron_secret')
    ),
    body := '{}'::jsonb
  );
  $$
);
