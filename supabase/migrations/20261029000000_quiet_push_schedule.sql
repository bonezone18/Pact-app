-- The send-notifications schedule only calls the Edge Function once its Vault
-- secrets exist, so a fresh (e.g. local) database doesn't log a failed
-- request every minute.
do $$
begin
  perform cron.schedule('send-notifications', '* * * * *', $cmd$
    select net.http_post(
      url := (select decrypted_secret from vault.decrypted_secrets where name = 'project_url')
             || '/functions/v1/send-notifications',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret')),
      body := '{}'::jsonb,
      timeout_milliseconds := 55000)
    where exists (select 1 from vault.decrypted_secrets where name = 'project_url')
      and exists (select 1 from vault.decrypted_secrets where name = 'cron_secret')
  $cmd$);
end $$;
