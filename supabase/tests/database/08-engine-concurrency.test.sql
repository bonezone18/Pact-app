-- Acceptance: two engine runs at the same moment -> no duplicate events.
--
-- Needs real parallel sessions, so the fixtures are committed through dblink
-- and cleaned up at the end. Set `pact.test_dsn` (scripts/test-db.sh does) to
-- a libpq connection string for this database; without it the file skips.
begin;
create extension if not exists dblink with schema extensions;
select plan(5);

create function pg_temp.concurrency() returns setof text
language plpgsql as $$
declare
  dsn text := nullif(current_setting('pact.test_dsn', true), '');
  n1 integer;
  n2 integer;
  cleanup text := $q$
    delete from public.pacts where title in ('Race A', 'Race B');
    delete from auth.users where email like 'race%@example.com';
  $q$;
begin
  if dsn is null then
    return next skip('pact.test_dsn is not set; concurrency tests need a second connection', 5);
    return;
  end if;

  perform dblink_connect('setup', dsn);
  perform dblink_exec('setup', cleanup);
  perform * from dblink('setup', $q$
    select tests.create_user(n)::text from unnest(array['RaceA1','RaceA2','RaceB1','RaceB2']) n
  $q$) t(x text);
  perform * from dblink('setup', $q$
    select tests.pair('RaceA1', 'RaceA2', 'Race A', '2026-10-22 08:00Z')::text
     union all select tests.pair('RaceB1', 'RaceB2', 'Race B', '2026-10-22 08:00Z')::text
  $q$) t(x text);
  perform * from dblink('setup', $q$
    select tests.tap(n, tests.pact(p), '2026-10-22 09:00Z')::text
      from (values ('RaceA1','Race A'), ('RaceA2','Race A'), ('RaceB1','Race B'), ('RaceB2','Race B')) v(n, p)
  $q$) t(x text);

  perform dblink_connect('run1', dsn);
  perform dblink_connect('run2', dsn);
  perform dblink_exec('run2', $q$set statement_timeout = '5s'$q$);

  -- Run 1 holds the pact row locks in an open transaction while run 2 starts.
  perform dblink_exec('run1', 'begin');
  select x into n1 from dblink('run1', $q$select public.evaluate_due_pacts('2026-10-23 00:15Z')$q$) t(x int);
  select x into n2 from dblink('run2', $q$select public.evaluate_due_pacts('2026-10-23 00:15Z')$q$) t(x int);
  return next is(n2, 0, 'an overlapping run skips locked pacts instead of waiting or double-counting');
  perform dblink_exec('run1', 'commit');
  return next is(n1, 2, 'the first run evaluated both pacts');

  select x into n2 from dblink('run2', $q$select public.evaluate_due_pacts('2026-10-23 00:30Z')$q$) t(x int);
  return next is(n2, 0, 'a run after the first commits finds nothing left to do');

  return next results_eq(
    $q$select p.title, count(e.*)::int, p.current_streak
         from public.pacts p left join public.streak_events e on e.pact_id = p.id
        where p.title in ('Race A', 'Race B') group by p.title, p.current_streak order by p.title$q$,
    $q$values ('Race A'::text, 1, 1), ('Race B'::text, 1, 1)$q$,
    'exactly one event and one streak change per pact');

  -- Truly simultaneous: both runs dispatched before either returns.
  perform * from dblink('setup', $q$
    select tests.tap(n, tests.pact(p), '2026-10-23 09:00Z')::text
      from (values ('RaceA1','Race A'), ('RaceA2','Race A'), ('RaceB1','Race B'), ('RaceB2','Race B')) v(n, p)
  $q$) t(x text);
  perform dblink_send_query('run1', $q$select public.evaluate_due_pacts('2026-10-24 00:15Z')$q$);
  perform dblink_send_query('run2', $q$select public.evaluate_due_pacts('2026-10-24 00:15Z')$q$);
  perform * from dblink_get_result('run1') t(x int);
  perform * from dblink_get_result('run1') t(x int);
  perform * from dblink_get_result('run2') t(x int);
  perform * from dblink_get_result('run2') t(x int);
  return next results_eq(
    $q$select p.title, count(e.*)::int, p.current_streak
         from public.pacts p left join public.streak_events e on e.pact_id = p.id
        where p.title in ('Race A', 'Race B') group by p.title, p.current_streak order by p.title$q$,
    $q$values ('Race A'::text, 2, 2), ('Race B'::text, 2, 2)$q$,
    'two simultaneous runs write one event per pact day');

  perform dblink_exec('setup', cleanup);
  perform dblink_disconnect('run1');
  perform dblink_disconnect('run2');
  perform dblink_disconnect('setup');
end $$;

select * from pg_temp.concurrency();

select * from finish();
rollback;
