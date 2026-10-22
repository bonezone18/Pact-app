-- Two sender runs at the same moment never send the same row twice.
-- Same setup as 08: needs pact.test_dsn, otherwise skips.
begin;
create extension if not exists dblink with schema extensions;
select plan(3);

create function pg_temp.concurrency() returns setof text
language plpgsql as $$
declare
  dsn text := nullif(current_setting('pact.test_dsn', true), '');
  a integer;
  b integer;
  cleanup text := $q$ delete from auth.users where email = 'pushrace@example.com' $q$;
begin
  if dsn is null then
    return next skip('pact.test_dsn is not set; concurrency tests need a second connection', 3);
    return;
  end if;

  perform dblink_connect('setup', dsn);
  perform dblink_exec('setup', cleanup);
  perform * from dblink('setup', $q$ select tests.create_user('PushRace')::text $q$) t(x text);
  perform dblink_exec('setup', $q$
    insert into public.notification_outbox (user_id, kind, payload, dedupe_key, send_after)
    select tests.uid('PushRace'), 'nudge', '{}', 'pushrace:' || g, '2026-10-22 12:00Z' from generate_series(1, 4) g
  $q$);

  perform dblink_connect('run1', dsn);
  perform dblink_connect('run2', dsn);
  perform dblink_exec('run2', $q$set statement_timeout = '5s'$q$);

  perform dblink_exec('run1', 'begin');
  select count(*) into a from dblink('run1', $q$select id from private.claim_notifications(100, '2026-10-22 12:00:30Z')$q$) t(id bigint);
  select count(*) into b from dblink('run2', $q$select id from private.claim_notifications(100, '2026-10-22 12:00:30Z')$q$) t(id bigint);
  return next is(b, 0, 'a run overlapping an open claim skips the locked rows instead of waiting');
  perform dblink_exec('run1', 'commit');
  return next is(a, 4, 'the first run claimed everything due');

  select count(*) into b from dblink('run2', $q$select id from private.claim_notifications(100, '2026-10-22 12:00:40Z')$q$) t(id bigint);
  return next is(b, 0, 'after it commits, the lease keeps the rows away from the second run');

  perform dblink_exec('setup', cleanup);
  perform dblink_disconnect('run1');
  perform dblink_disconnect('run2');
  perform dblink_disconnect('setup');
end $$;

select * from pg_temp.concurrency();
select * from finish();
rollback;
