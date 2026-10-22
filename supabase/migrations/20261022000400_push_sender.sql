-- Phase 6 — delivering notification_outbox.
--
-- SQL decides who gets what and when (earlier phases). The send-notifications
-- Edge Function runs every minute and works through due rows:
--   claim -> send through Expo Push -> mark sent / release for retry.
-- A claim is a 2-minute lease, so overlapping runs never send a row twice,
-- and each claim counts as an attempt: a row gets at most 3.

alter table public.notification_outbox
  add column claimed_until timestamptz,
  add column last_error text;

create function private.claim_notifications(p_limit integer, p_now timestamptz)
returns table (id bigint, user_id uuid, kind text, payload jsonb, attempts smallint, tokens text[])
language plpgsql as $$
#variable_conflict use_column
begin
  return query
  with due as (
    select o.id
      from public.notification_outbox o
     where o.sent_at is null
       and o.send_after <= p_now
       and o.attempts < 3
       and (o.claimed_until is null or o.claimed_until <= p_now)
     order by o.send_after, o.id
     limit p_limit
     for update skip locked
  ), claimed as (
    update public.notification_outbox o
       set attempts = o.attempts + 1, claimed_until = p_now + interval '2 minutes'
      from due
     where o.id = due.id
    returning o.id, o.user_id, o.kind, o.payload, o.attempts
  )
  select c.id, c.user_id, c.kind, c.payload, c.attempts,
         coalesce((select array_agg(t.token order by t.token)
                     from public.push_tokens t where t.user_id = c.user_id), '{}')
    from claimed c
   order by c.id;
end $$;

create function private.mark_notifications_sent(p_ids bigint[], p_now timestamptz) returns void
language sql as $$
  update public.notification_outbox
     set sent_at = p_now, claimed_until = null, last_error = null
   where id = any(p_ids) and sent_at is null;
$$;

-- Failed this time: make it claimable again on the next run (if attempts remain).
create function private.release_notifications(p_ids bigint[], p_error text) returns void
language sql as $$
  update public.notification_outbox
     set claimed_until = null, last_error = left(p_error, 500)
   where id = any(p_ids) and sent_at is null;
$$;

-- Expo answered DeviceNotRegistered: the app was uninstalled or the token rotated.
create function private.drop_push_tokens(p_tokens text[]) returns integer
language plpgsql as $$
declare
  n integer;
begin
  delete from public.push_tokens where token = any(p_tokens);
  get diagnostics n = row_count;
  return n;
end $$;

-- Wrappers for the Edge Function (service role only).
create function public.claim_notifications(max_rows integer default 100)
returns table (id bigint, user_id uuid, kind text, payload jsonb, attempts smallint, tokens text[])
language sql security definer set search_path = public as $$
  select * from private.claim_notifications(least(greatest(claim_notifications.max_rows, 1), 500), now());
$$;

create function public.mark_notifications_sent(ids bigint[]) returns void
language sql security definer set search_path = public as $$
  select private.mark_notifications_sent(mark_notifications_sent.ids, now());
$$;

create function public.release_notifications(ids bigint[], error text) returns void
language sql security definer set search_path = public as $$
  select private.release_notifications(release_notifications.ids, release_notifications.error);
$$;

create function public.drop_push_tokens(tokens text[]) returns integer
language sql security definer set search_path = public as $$
  select private.drop_push_tokens(drop_push_tokens.tokens);
$$;

revoke execute on function public.claim_notifications(integer),
                           public.mark_notifications_sent(bigint[]),
                           public.release_notifications(bigint[], text),
                           public.drop_push_tokens(text[])
  from public, anon, authenticated;
grant execute on function public.claim_notifications(integer),
                          public.mark_notifications_sent(bigint[]),
                          public.release_notifications(bigint[], text),
                          public.drop_push_tokens(text[])
  to service_role;

-- Clean out delivered rows after two weeks (nudge limits only look at today).
create function public.purge_sent_notifications(p_now timestamptz default now()) returns integer
language plpgsql security definer set search_path = public as $$
declare
  n integer;
begin
  delete from notification_outbox
   where (sent_at is not null and sent_at < p_now - interval '14 days')
      or (sent_at is null and attempts >= 3 and send_after < p_now - interval '14 days');
  get diagnostics n = row_count;
  return n;
end $$;
revoke execute on function public.purge_sent_notifications(timestamptz) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Schedules
--
-- The sender is called over HTTP with pg_net. Its URL and shared secret live
-- in Supabase Vault (see README), never in a migration:
--   select vault.create_secret('https://<ref>.supabase.co', 'project_url');
--   select vault.create_secret('<random string>', 'cron_secret');
-- ---------------------------------------------------------------------------

do $$
begin
  create extension if not exists pg_net;
exception when others then
  raise notice 'pg_net not available here (%); the send-notifications schedule will not run', sqlerrm;
end $$;

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
  $cmd$);
  perform cron.schedule('purge-sent-notifications', '17 3 * * *', 'select public.purge_sent_notifications()');
end $$;

-- ---------------------------------------------------------------------------
-- Device registration
--
-- A token belongs to whoever is signed in on that device now. A plain upsert
-- can't move a row owned by a previous account (RLS hides it), so the app
-- registers through this function.
-- ---------------------------------------------------------------------------

create function private.register_push_token(p_token text, p_platform text, p_now timestamptz) returns void
language plpgsql as $$
declare
  uid uuid := private.require_uid();
begin
  if p_platform is null or p_platform not in ('ios', 'android') then
    perform private.fail('invalid_platform');
  end if;
  if p_token is null or p_token !~ '^Expo(nent)?PushToken\[.+\]$' then
    perform private.fail('invalid_token');
  end if;
  insert into public.push_tokens (token, user_id, platform, updated_at)
  values (p_token, uid, p_platform, p_now)
  on conflict (token) do update
    set user_id = excluded.user_id, platform = excluded.platform, updated_at = excluded.updated_at;
end $$;

create function public.register_push_token(token text, platform text) returns void
language sql security definer set search_path = public as $$
  select private.register_push_token(register_push_token.token, register_push_token.platform, now());
$$;

revoke execute on function public.register_push_token(text, text) from public, anon;
grant execute on function public.register_push_token(text, text) to authenticated;
