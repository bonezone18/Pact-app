-- Acceptance: streak engine and timezones, on a fixed clock.
begin;
select plan(48);

-- Events for a pact, as (date, outcome, before, after).
create function pg_temp.events(p uuid) returns table (d date, outcome text, b int, a int)
language sql as $$
  select local_date, outcome, streak_before, streak_after from public.streak_events
   where pact_id = p order by local_date;
$$;

-- ===========================================================================
-- Streak engine
-- ===========================================================================

-- Both members check in for D -> streak +1, one extended event.
select tests.create_user('A1');
select tests.create_user('B1');
select tests.pair('A1', 'B1', 'Both in', '2026-10-22 08:00Z');
select tests.tap('A1', tests.pact('Both in'), '2026-10-22 09:00Z');
select tests.tap('B1', tests.pact('Both in'), '2026-10-22 21:00Z');

select public.evaluate_due_pacts('2026-10-23 00:14Z');
select is_empty($$select * from pg_temp.events(tests.pact('Both in'))$$, 'day not evaluated before close (midnight + 15 min)');
select public.evaluate_due_pacts('2026-10-23 00:15Z');
select results_eq($$select * from pg_temp.events(tests.pact('Both in'))$$,
                  $$values ('2026-10-22'::date, 'extended'::text, 0, 1)$$,
                  'both checked in: one extended event');
select results_eq($$select current_streak, longest_streak, last_evaluated_date from public.pacts where title = 'Both in'$$,
                  $$values (1, 1, '2026-10-22'::date)$$,
                  'streak +1, longest_streak updated, cursor advanced');

-- One member misses with streak 5 -> broken, streak 0, longest stays 5.
select tests.create_user('A2');
select tests.create_user('B2');
select tests.pair('A2', 'B2', 'Five day', '2026-10-17 08:00Z');
update public.pacts set current_streak = 5, longest_streak = 5, last_evaluated_date = '2026-10-21'
 where title = 'Five day';
select tests.tap('A2', tests.pact('Five day'), '2026-10-22 09:00Z');
select public.evaluate_due_pacts('2026-10-23 00:15Z');
select results_eq($$select outcome, streak_before, streak_after, missed_user_ids from public.streak_events
                     where pact_id = tests.pact('Five day')$$,
                  $$values ('broken'::text, 5, 0, array[tests.uid('B2')])$$,
                  'broken event lists the member who missed');
select results_eq($$select current_streak, longest_streak from public.pacts where title = 'Five day'$$,
                  $$values (0, 5)$$,
                  'streak resets to 0; longest_streak stays 5');
select is((select count(*)::int from public.notification_outbox
            where kind = 'broken' and payload ->> 'pact_id' = tests.pact('Five day')::text), 2,
          'broken push queued for both members');

-- Miss while streak is 0 -> silent_miss, no broken push.
select tests.create_user('A3');
select tests.create_user('B3');
select tests.pair('A3', 'B3', 'Day one', '2026-10-22 08:00Z');
select tests.tap('A3', tests.pact('Day one'), '2026-10-22 09:00Z');
select public.evaluate_due_pacts('2026-10-23 00:15Z');
select results_eq($$select * from pg_temp.events(tests.pact('Day one'))$$,
                  $$values ('2026-10-22'::date, 'silent_miss'::text, 0, 0)$$,
                  'miss at streak 0 is a silent_miss');
select is((select count(*)::int from public.notification_outbox
            where kind = 'broken' and payload ->> 'pact_id' = tests.pact('Day one')::text), 0,
          'no broken push for a silent_miss');

-- Engine runs 10 times between close and the next day -> one event, one change.
select tests.create_user('A4');
select tests.create_user('B4');
select tests.pair('A4', 'B4', 'Ten runs', '2026-10-22 08:00Z');
select tests.tap('A4', tests.pact('Ten runs'), '2026-10-22 09:00Z');
select tests.tap('B4', tests.pact('Ten runs'), '2026-10-22 10:00Z');
select public.evaluate_due_pacts('2026-10-23 00:15Z'::timestamptz + i * interval '15 minutes')
  from generate_series(0, 9) i;
select is((select count(*)::int from public.streak_events where pact_id = tests.pact('Ten runs')), 1,
          '10 runs after close write exactly one event');
select is((select current_streak from public.pacts where title = 'Ten runs'), 1,
          '10 runs change the streak exactly once');

-- Engine down for 3 days -> the next run evaluates the 3 dates in order.
select tests.create_user('A5');
select tests.create_user('B5');
select tests.pair('A5', 'B5', 'Outage', '2026-10-22 08:00Z');
select tests.tap('A5', tests.pact('Outage'), '2026-10-22 09:00Z');
select tests.tap('B5', tests.pact('Outage'), '2026-10-22 09:00Z');
select tests.tap('A5', tests.pact('Outage'), '2026-10-23 09:00Z');
select tests.tap('B5', tests.pact('Outage'), '2026-10-23 09:00Z');
select tests.tap('A5', tests.pact('Outage'), '2026-10-24 09:00Z');
select public.evaluate_due_pacts('2026-10-25 12:00Z');
select results_eq($$select * from pg_temp.events(tests.pact('Outage'))$$,
                  $$values ('2026-10-22'::date, 'extended'::text, 0, 1),
                           ('2026-10-23'::date, 'extended'::text, 1, 2),
                           ('2026-10-24'::date, 'broken'::text,   2, 0)$$,
                  'catch-up evaluates each missed date in order, chaining the streak');
select results_eq($$select current_streak, longest_streak, last_evaluated_date from public.pacts where title = 'Outage'$$,
                  $$values (0, 2, '2026-10-24'::date)$$,
                  'cursor ends on the last closed date');

-- A re-run that hits an already-written day fails safely, and only for that pact.
select tests.create_user('A6');
select tests.create_user('B6');
select tests.create_user('C6');
select tests.create_user('D6');
select tests.pair('A6', 'B6', 'Raced', '2026-10-22 08:00Z');
select tests.pair('C6', 'D6', 'Bystander', '2026-10-22 08:00Z');
insert into public.streak_events (pact_id, local_date, outcome, streak_before, streak_after)
values (tests.pact('Raced'), '2026-10-22', 'silent_miss', 0, 0);  -- as if another run got here first
select lives_ok($$select public.evaluate_due_pacts('2026-10-23 00:15Z')$$,
                'duplicate day does not abort the run');
select is((select count(*)::int from public.streak_events where pact_id = tests.pact('Raced')), 1,
          'still exactly one event for the raced day');
select is((select count(*)::int from public.streak_events where pact_id = tests.pact('Bystander')), 1,
          'other pacts in the same run are still evaluated');

-- Pending and archived pacts are never evaluated.
select tests.create_user('Solo');
select tests.login('Solo');
select private.create_pact('Waiting room', 'tap', 2, '2026-10-20 08:00Z');
select public.evaluate_due_pacts('2026-10-25 00:15Z');
select is((select count(*)::int from public.streak_events where pact_id = tests.pact('Waiting room')), 0,
          'pending pacts are not evaluated');

-- ===========================================================================
-- Timezones
-- ===========================================================================

-- Tokyo (UTC+9) + New York (UTC-4): Oct 22 closes at 04:15 UTC Oct 23.
select tests.create_user('Kenji', 'Asia/Tokyo');
select tests.create_user('Nora', 'America/New_York');
select tests.pair('Kenji', 'Nora', 'Tokyo NY', '2026-10-22 00:30Z');  -- Tokyo Oct 22 09:30, NY Oct 21 20:30
select is((select start_date from public.pacts where title = 'Tokyo NY'), '2026-10-22'::date,
          'start_date is the later founder date');
select is(tests.tap('Kenji', tests.pact('Tokyo NY'), '2026-10-22 01:00Z'), '2026-10-22'::date,
          'Tokyo 10:00 Oct 22 counts for Oct 22');
select is(tests.tap('Nora', tests.pact('Tokyo NY'), '2026-10-23 00:00Z'), '2026-10-22'::date,
          'New York 20:00 Oct 22 (00:00 UTC Oct 23) counts for Oct 22');
select public.evaluate_due_pacts('2026-10-22 15:15Z');  -- Tokyo midnight + 15
select is_empty($$select * from pg_temp.events(tests.pact('Tokyo NY'))$$,
                'not evaluated at Tokyo''s midnight + 15 min');
select public.evaluate_due_pacts('2026-10-23 04:14Z');
select is_empty($$select * from pg_temp.events(tests.pact('Tokyo NY'))$$,
                'not evaluated one minute before New York''s midnight + 15 min');
select public.evaluate_due_pacts('2026-10-23 04:15Z');
select results_eq($$select * from pg_temp.events(tests.pact('Tokyo NY'))$$,
                  $$values ('2026-10-22'::date, 'extended'::text, 0, 1)$$,
                  'Tokyo + New York both on their own Oct 22 -> extended');

-- Same pair, Tokyo misses: no reset before New York's day is over.
select tests.tap('Nora', tests.pact('Tokyo NY'), '2026-10-23 14:00Z');  -- NY 10:00 Oct 23
select public.evaluate_due_pacts('2026-10-23 15:15Z');  -- Tokyo's Oct 23 is over
select is((select current_streak from public.pacts where title = 'Tokyo NY'), 1,
          'Tokyo''s miss does not reset the streak before New York''s midnight');
select public.evaluate_due_pacts('2026-10-24 04:15Z');
select results_eq($$select missed_user_ids from public.streak_events
                     where pact_id = tests.pact('Tokyo NY') and local_date = '2026-10-23'$$,
                  $$values (array[tests.uid('Kenji')])$$,
                  'Tokyo''s miss is recorded once the last zone closes');

-- DST end in New York (Nov 1 2026 is a 25-hour day): closes 05:15 UTC, not 04:15.
select tests.create_user('Fall1', 'America/New_York');
select tests.create_user('Fall2', 'America/New_York');
select tests.pair('Fall1', 'Fall2', 'Fall back', '2026-11-01 12:00Z');
select tests.tap('Fall1', tests.pact('Fall back'), '2026-11-01 13:00Z');
select tests.tap('Fall2', tests.pact('Fall back'), '2026-11-02 04:30Z');  -- 23:30 EST Nov 1
select is((select local_date from public.check_ins where user_id = tests.uid('Fall2')), '2026-11-01'::date,
          '23:30 local in the 25th hour still counts for Nov 1');
select public.evaluate_due_pacts('2026-11-02 04:15Z');
select is_empty($$select * from pg_temp.events(tests.pact('Fall back'))$$,
                '25-hour day is not closed on the summer-time clock');
select public.evaluate_due_pacts('2026-11-02 05:15Z');
select results_eq($$select * from pg_temp.events(tests.pact('Fall back'))$$,
                  $$values ('2026-11-01'::date, 'extended'::text, 0, 1)$$,
                  '25-hour day closes at local midnight (05:00 UTC) + 15 min');

-- DST start in New York (Mar 8 2026 is a 23-hour day): closes 04:15 UTC, not 05:15.
select tests.create_user('Spring1', 'America/New_York');
select tests.create_user('Spring2', 'America/New_York');
select tests.pair('Spring1', 'Spring2', 'Spring forward', '2026-03-08 13:00Z');
select tests.tap('Spring1', tests.pact('Spring forward'), '2026-03-08 14:00Z');
select public.evaluate_due_pacts('2026-03-09 04:14Z');
select is_empty($$select * from pg_temp.events(tests.pact('Spring forward'))$$,
                '23-hour day not closed early');
select public.evaluate_due_pacts('2026-03-09 04:15Z');
select results_eq($$select * from pg_temp.events(tests.pact('Spring forward'))$$,
                  $$values ('2026-03-08'::date, 'silent_miss'::text, 0, 0)$$,
                  '23-hour day closes at local midnight (04:00 UTC) + 15 min');

-- UTC+5:30: closes at the member's midnight + 15 min, not on the hour.
select tests.create_user('Priya', 'Asia/Kolkata');
select tests.create_user('Ravi', 'Asia/Kolkata');
select tests.pair('Priya', 'Ravi', 'Half hour', '2026-10-22 03:00Z');
select tests.tap('Priya', tests.pact('Half hour'), '2026-10-22 04:00Z');
select tests.tap('Ravi', tests.pact('Half hour'), '2026-10-22 18:20Z');  -- 23:50 IST
select public.evaluate_due_pacts('2026-10-22 18:30Z');
select is_empty($$select * from pg_temp.events(tests.pact('Half hour'))$$, 'not closed at IST midnight itself');
select public.evaluate_due_pacts('2026-10-22 18:44Z');
select is_empty($$select * from pg_temp.events(tests.pact('Half hour'))$$, 'not closed at 18:44 UTC');
select public.evaluate_due_pacts('2026-10-22 18:45Z');
select results_eq($$select * from pg_temp.events(tests.pact('Half hour'))$$,
                  $$values ('2026-10-22'::date, 'extended'::text, 0, 1)$$,
                  'UTC+5:30 day closes at 18:45 UTC (00:15 IST)');

-- Timezone change applies only at the next local midnight; one change per 24 h.
select tests.create_user('Trav');
select tests.login('Trav');
select is((private.set_timezone('Asia/Tokyo', '2026-10-22 10:00Z') ->> 'applies_at')::timestamptz,
          '2026-10-23 00:00Z'::timestamptz, 'change is scheduled for the next local midnight in the old zone');
select results_eq($$select timezone, pending_timezone from public.profiles where display_name = 'Trav'$$,
                  $$values ('UTC'::text, 'Asia/Tokyo'::text)$$,
                  'new zone waits in pending_timezone');
select public.apply_pending_timezones('2026-10-22 23:59Z');
select is((select timezone from public.profiles where display_name = 'Trav'), 'UTC',
          'not applied before midnight');
select public.apply_pending_timezones('2026-10-23 00:00Z');
select results_eq($$select timezone, pending_timezone from public.profiles where display_name = 'Trav'$$,
                  $$values ('Asia/Tokyo'::text, null::text)$$,
                  'applied at the old zone''s midnight');
select throws_ok($$select private.set_timezone('Europe/Paris', '2026-10-23 09:59Z')$$,
                 'P0001', 'rate_limited', 'a second change within 24 h is rejected');
select lives_ok($$select private.set_timezone('Europe/Paris', '2026-10-23 10:00Z')$$,
                'a change 24 h later is accepted');
select lives_ok($$select private.set_timezone('Asia/Tokyo', '2026-10-23 10:05Z')$$,
                'moving back to the current zone just cancels the pending change');
select is((select pending_timezone from public.profiles where display_name = 'Trav'), null,
          'pending change cancelled');

-- Activated across the date line: the earlier zone gets not_started until start_date.
select tests.create_user('Kiri', 'Pacific/Kiritimati');  -- UTC+14
select tests.create_user('Hono', 'Pacific/Honolulu');    -- UTC-10
select tests.pair('Kiri', 'Hono', 'Date line', '2026-10-22 12:00Z');  -- Kiri Oct 23 02:00, Hono Oct 22 02:00
select is((select start_date from public.pacts where title = 'Date line'), '2026-10-23'::date,
          'start_date is the later founder date (Oct 23)');
select throws_ok(format('select tests.tap(%L, %L, %L)', 'Hono', tests.pact('Date line'), '2026-10-22 12:30Z'),
                 'P0001', 'not_started', 'Honolulu on Oct 22 gets not_started');
select is(tests.tap('Kiri', tests.pact('Date line'), '2026-10-22 12:30Z'), '2026-10-23'::date,
          'Kiritimati can check in for Oct 23 right away');
select is(tests.tap('Hono', tests.pact('Date line'), '2026-10-23 12:00Z'), '2026-10-23'::date,
          'Honolulu checks in once their Oct 23 starts');
select public.evaluate_due_pacts('2026-10-24 10:14Z');
select is_empty($$select * from pg_temp.events(tests.pact('Date line'))$$,
                'Oct 23 stays open until Honolulu''s midnight + 15 min');
select public.evaluate_due_pacts('2026-10-24 10:15Z');
select results_eq($$select * from pg_temp.events(tests.pact('Date line'))$$,
                  $$values ('2026-10-23'::date, 'extended'::text, 0, 1)$$,
                  'Day 1 is Oct 23; Oct 22 is never evaluated');

-- Mid-day pod joiner is not required on their join day.
select tests.create_user('PodA');
select tests.create_user('PodB');
select tests.create_user('PodC');
select tests.grant_pro('PodA');
select tests.login('PodA');
select set_config('t.pod', private.create_pact('Pod', 'tap', 3, '2026-10-22 08:00Z')::text, true);
select tests.login('PodB');
select private.join_pact(current_setting('t.pod')::jsonb ->> 'code', '2026-10-22 08:00Z');
select tests.tap('PodA', tests.pact('Pod'), '2026-10-22 09:00Z');
select tests.tap('PodB', tests.pact('Pod'), '2026-10-22 09:00Z');
select tests.login('PodC');
select private.join_pact(current_setting('t.pod')::jsonb ->> 'code', '2026-10-22 12:00Z');
select public.evaluate_due_pacts('2026-10-23 00:15Z');
select results_eq($$select * from pg_temp.events(tests.pact('Pod'))$$,
                  $$values ('2026-10-22'::date, 'extended'::text, 0, 1)$$,
                  'someone joining mid-day is not required until the next day');
select public.evaluate_due_pacts('2026-10-24 00:15Z');
select results_eq($$select missed_user_ids from public.streak_events
                     where pact_id = tests.pact('Pod') and local_date = '2026-10-23'$$,
                  $$values (array(select u from unnest(array[tests.uid('PodA'), tests.uid('PodB'), tests.uid('PodC')]) u order by u))$$,
                  '... and is required from the next day on');

select * from finish();
rollback;
