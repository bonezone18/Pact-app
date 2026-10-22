-- Phase 5: pact_today, the dashboard's view of the caller's day.
begin;
select plan(22);

create function pg_temp.member(today jsonb, name text) returns jsonb
language sql as $$
  select m from jsonb_array_elements(today -> 'members') m where m ->> 'display_name' = name;
$$;

-- Tokyo (UTC+9) and New York (UTC-4), active from Oct 22.
select tests.create_user('Kenji', 'Asia/Tokyo');
select tests.create_user('Nora', 'America/New_York');
select tests.create_user('Outsider');
select tests.pair('Kenji', 'Nora', 'Tokyo NY', '2026-10-22 00:30Z');
select tests.tap('Kenji', tests.pact('Tokyo NY'), '2026-10-22 01:00Z');  -- Tokyo 10:00 Oct 22

select tests.login('Outsider');
select throws_ok(format('select private.pact_today(%L, now())', tests.pact('Tokyo NY')),
                 'P0001', 'not_member', 'non-members get nothing');

-- New York, 20:00 Oct 22: Tokyo's Oct 22 check-in is visible all day.
select tests.login('Nora');
select set_config('t.ny', private.pact_today(tests.pact('Tokyo NY'), '2026-10-23 00:00Z')::text, true);
select is(current_setting('t.ny')::jsonb ->> 'date', '2026-10-22', 'anchored on the viewer''s local date');
select is(current_setting('t.ny')::jsonb -> 'members' -> 0 ->> 'display_name', 'Nora', 'the viewer is listed first');
select is(pg_temp.member(current_setting('t.ny')::jsonb, 'Kenji') ->> 'state', 'done',
          'New York sees Tokyo''s check-in for Oct 22');
select ok(pg_temp.member(current_setting('t.ny')::jsonb, 'Kenji') -> 'check_in' ->> 'id' is not null,
          'with the check-in attached');
select is(pg_temp.member(current_setting('t.ny')::jsonb, 'Nora') ->> 'state', 'pending', 'viewer still pending');
select is((pg_temp.member(current_setting('t.ny')::jsonb, 'Nora') ->> 'day_ends_at')::timestamptz,
          '2026-10-23 04:00Z'::timestamptz, 'viewer''s day ends at their local midnight');
select is(current_setting('t.ny')::jsonb ->> 'nudges_left', '2', 'two nudges available');
select is(current_setting('t.ny')::jsonb ->> 'not_started', 'false', 'pact started');

-- Tokyo, 10:00 Oct 23: their new day; New York is still on Oct 22.
select tests.login('Kenji');
select set_config('t.tk', private.pact_today(tests.pact('Tokyo NY'), '2026-10-23 01:00Z')::text, true);
select is(current_setting('t.tk')::jsonb ->> 'date', '2026-10-23', 'Tokyo is on Oct 23');
select is(pg_temp.member(current_setting('t.tk')::jsonb, 'Nora') ->> 'state', 'pending',
          'New York''s Oct 23 has not started: pending, not missed');
select is(pg_temp.member(current_setting('t.tk')::jsonb, 'Nora') ->> 'local_date', '2026-10-22',
          'each member''s own current date is reported');
select is((pg_temp.member(current_setting('t.tk')::jsonb, 'Nora') ->> 'day_ends_at')::timestamptz,
          '2026-10-24 04:00Z'::timestamptz, 'partner''s Oct 23 ends at their midnight');

-- New York at 23:30 Oct 23 with Tokyo having missed Oct 23 (Tokyo's day is over).
select tests.login('Nora');
select is(pg_temp.member(private.pact_today(tests.pact('Tokyo NY'), '2026-10-24 03:30Z'), 'Kenji') ->> 'state',
          'missed', 'a partner whose day ended without a check-in is missed');

-- Reactions and nudges.
select tests.tap('Nora', tests.pact('Tokyo NY'), '2026-10-23 12:00Z');  -- NY 08:00 Oct 23
select tests.login('Kenji');
select private.react((select id from public.check_ins where user_id = tests.uid('Nora') and local_date = '2026-10-23'),
                     'fire', '2026-10-23 12:05Z');
select tests.login('Nora');
select is(pg_temp.member(private.pact_today(tests.pact('Tokyo NY'), '2026-10-23 12:10Z'), 'Nora')
            -> 'check_in' -> 'reactions',
          jsonb_build_array(jsonb_build_object('user_id', tests.uid('Kenji'), 'kind', 'fire')),
          'reactions come with the check-in');
select private.nudge(tests.pact('Tokyo NY'), tests.uid('Kenji'), '2026-10-23 12:10Z');
select is(private.pact_today(tests.pact('Tokyo NY'), '2026-10-23 12:15Z') ->> 'nudges_left', '1',
          'nudges_left counts down');

-- The hero number comes from the engine's result.
select tests.tap('Nora', tests.pact('Tokyo NY'), '2026-10-23 03:00Z');  -- NY 23:00 Oct 22
select public.evaluate_due_pacts('2026-10-23 04:15Z');  -- Oct 22: both checked in
select results_eq(
  $$select (t -> 'pact' ->> 'current_streak')::int, (t -> 'pact' ->> 'longest_streak')::int
      from (select private.pact_today(tests.pact('Tokyo NY'), '2026-10-23 12:20Z') t) x$$,
  $$values (1, 1)$$,
  'streak numbers reflect the evaluated day');
select is(private.pact_today(tests.pact('Tokyo NY'), '2026-10-23 03:59Z') ->> 'date', '2026-10-22',
          'New York is still on Oct 22 one minute before midnight');

-- Mid-day pod joiner: not required today.
select tests.create_user('PodA');
select tests.create_user('PodB');
select tests.create_user('PodC');
select tests.grant_pro('PodA');
select tests.login('PodA');
select set_config('t.pod', private.create_pact('Pod', 'tap', 3, '2026-10-22 08:00Z') ->> 'code', true);
select tests.login('PodB');
select private.join_pact(current_setting('t.pod'), '2026-10-22 08:00Z');
select tests.login('PodC');
select private.join_pact(current_setting('t.pod'), '2026-10-22 12:00Z');
select is(pg_temp.member(private.pact_today(tests.pact('Pod'), '2026-10-22 13:00Z'), 'PodC') ->> 'state',
          'not_required', 'a mid-day joiner is not required today');
select is(pg_temp.member(private.pact_today(tests.pact('Pod'), '2026-10-22 13:00Z'), 'PodC') ->> 'required',
          'false', '... and flagged as such');

-- Across the date line: Day 1 hasn't started for Honolulu.
select tests.create_user('Kiri', 'Pacific/Kiritimati');
select tests.create_user('Hono', 'Pacific/Honolulu');
select tests.pair('Kiri', 'Hono', 'Date line', '2026-10-22 12:00Z');
select tests.login('Hono');
select is(private.pact_today(tests.pact('Date line'), '2026-10-22 12:30Z') ->> 'not_started', 'true',
          'the earlier zone sees not_started until start_date');

-- Members who left are not shown.
select tests.create_user('PodD');
select tests.login('PodB');
select private.leave_pact(tests.pact('Pod'), '2026-10-22 14:00Z');
select tests.login('PodA');
select is(jsonb_array_length(private.pact_today(tests.pact('Pod'), '2026-10-22 15:00Z') -> 'members'), 2,
          'only current members are listed');

select * from finish();
rollback;
