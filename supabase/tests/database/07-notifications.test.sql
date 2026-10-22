-- Acceptance: what lands in notification_outbox, and when. Delivery itself
-- (the Expo push sender) is Phase 6.
begin;
select plan(19);

create function pg_temp.outbox(p uuid) returns table (who text, kind text, send_after timestamptz)
language sql as $$
  select pr.display_name, o.kind, o.send_after
    from public.notification_outbox o join public.profiles pr on pr.id = o.user_id
   where o.payload ->> 'pact_id' = p::text
   order by o.id;
$$;

-- ---------------------------------------------------------------------------
-- Instant partner pushes
-- ---------------------------------------------------------------------------

select tests.create_user('Alice');
select tests.create_user('Bob');
select tests.pair('Alice', 'Bob', 'Walk', '2026-10-22 08:00Z');

select tests.tap('Alice', tests.pact('Walk'), '2026-10-22 09:00Z');
select results_eq($$select * from pg_temp.outbox(tests.pact('Walk'))$$,
                  $$values ('Bob'::text, 'partner_checked_in'::text, '2026-10-22 09:00Z'::timestamptz)$$,
                  'partner check-in queues a push to the pending member, due immediately');
select is((select payload ->> 'name' from public.notification_outbox where kind = 'partner_checked_in'), 'Alice',
          'push carries the name of who checked in');

select tests.tap('Bob', tests.pact('Walk'), '2026-10-22 18:00Z');
select results_eq($$select who, kind from pg_temp.outbox(tests.pact('Walk')) where kind = 'locked'$$,
                  $$values ('Alice'::text, 'locked'::text)$$,
                  'last member in: the others hear the day is locked');

-- ---------------------------------------------------------------------------
-- Scheduled reminders: never twice for the same date
-- ---------------------------------------------------------------------------

select tests.create_user('Cara');
select tests.create_user('Dev');
select tests.pair('Cara', 'Dev', 'Read', '2026-10-22 06:00Z');

select public.enqueue_reminders('2026-10-22 08:45Z');
select is_empty($$select * from pg_temp.outbox(tests.pact('Read'))$$, 'nothing before 09:00 local');

select public.enqueue_reminders(t)
  from unnest(array['2026-10-22 09:00Z', '2026-10-22 09:15Z', '2026-10-22 09:30Z', '2026-10-22 13:00Z']::timestamptz[]) t;
select results_eq($$select who, kind from pg_temp.outbox(tests.pact('Read')) order by who$$,
                  $$values ('Cara'::text, 'reminder_am'::text), ('Dev'::text, 'reminder_am'::text)$$,
                  'one 09:00 reminder per member however many runs');

select tests.tap('Cara', tests.pact('Read'), '2026-10-22 19:00Z');
select public.enqueue_reminders(t)
  from unnest(array['2026-10-22 20:00Z', '2026-10-22 20:15Z', '2026-10-22 22:45Z']::timestamptz[]) t;
select results_eq($$select who, kind from pg_temp.outbox(tests.pact('Read')) where kind = 'reminder_pm'$$,
                  $$values ('Dev'::text, 'reminder_pm'::text)$$,
                  'one 20:00 reminder, only to the member not yet checked in');
select is((select payload ->> 'name' from public.notification_outbox where kind = 'reminder_pm'), 'Cara',
          '20:00 reminder names who is counting on you');

-- Streak 0: no 23:00 pushes.
select public.enqueue_reminders('2026-10-22 23:00Z');
select is((select count(*)::int from pg_temp.outbox(tests.pact('Read')) where kind in ('reminder_late','waiting')), 0,
          'no 23:00 pushes while the streak is 0');

-- Next day with a live streak: late to the pending member, waiting to the done one.
update public.pacts set current_streak = 3, longest_streak = 3 where title = 'Read';
select tests.tap('Dev', tests.pact('Read'), '2026-10-23 12:00Z');
select public.enqueue_reminders(t)
  from unnest(array['2026-10-23 23:00Z', '2026-10-23 23:15Z', '2026-10-23 23:45Z']::timestamptz[]) t;
select results_eq($$select who, kind from pg_temp.outbox(tests.pact('Read'))
                     where kind in ('reminder_late','waiting') order by who$$,
                  $$values ('Cara'::text, 'reminder_late'::text), ('Dev'::text, 'waiting'::text)$$,
                  '23:00: "1 hour left" to the pending member, "send a nudge?" to the done one, once each');
select is((select payload ->> 'name' from public.notification_outbox where kind = 'waiting'), 'Cara',
          'waiting push names who is still pending');

-- Reminders off: no 09:00/20:00, but 23:00 still comes (it is the game).
select tests.login('Cara');
select private.set_reminders(tests.pact('Read'), false);
select public.enqueue_reminders(t)
  from unnest(array['2026-10-24 09:00Z', '2026-10-24 20:00Z', '2026-10-24 23:00Z']::timestamptz[]) t;
select results_eq($$select kind from pg_temp.outbox(tests.pact('Read'))
                     where who = 'Cara' and (send_after at time zone 'UTC')::date = '2026-10-24'$$,
                  $$values ('reminder_late'::text)$$,
                  'reminders_enabled = false silences 09:00 and 20:00 only');

-- Reminders follow the member's own clock.
select tests.create_user('Kenji', 'Asia/Tokyo');
select tests.create_user('Nora', 'America/New_York');
select tests.pair('Kenji', 'Nora', 'Tokyo NY', '2026-10-22 00:30Z');
select public.enqueue_reminders('2026-10-23 00:00Z');  -- Tokyo 09:00 Oct 23, NY 20:00 Oct 22
select results_eq($$select who, kind from pg_temp.outbox(tests.pact('Tokyo NY')) order by who$$,
                  $$values ('Kenji'::text, 'reminder_am'::text), ('Nora'::text, 'reminder_pm'::text)$$,
                  'each member is reminded at their own local time');

-- ---------------------------------------------------------------------------
-- Day results
-- ---------------------------------------------------------------------------

-- Broken at 03:15 for an east-coast member -> delivered 08:00 their time.
select tests.create_user('East', 'America/New_York');
select tests.create_user('West', 'America/Los_Angeles');
select tests.pair('East', 'West', 'Coast', '2026-10-22 14:00Z');
update public.pacts set current_streak = 4, longest_streak = 4, last_evaluated_date = '2026-10-21'
 where title = 'Coast';
select tests.tap('East', tests.pact('Coast'), '2026-10-22 15:00Z');
select public.evaluate_due_pacts('2026-10-23 07:15Z');  -- LA 00:15, NY 03:15
select results_eq($$select who, send_after from pg_temp.outbox(tests.pact('Coast')) where kind = 'broken' order by who$$,
                  $$values ('East'::text, '2026-10-23 12:00Z'::timestamptz),
                           ('West'::text, '2026-10-23 15:00Z'::timestamptz)$$,
                  'a broken result at night is held until 08:00 local for each member');
select is((select payload ->> 'streak_before' from public.notification_outbox
            where kind = 'broken' and payload ->> 'pact_id' = tests.pact('Coast')::text limit 1), '4',
          'broken push carries the streak that was lost');

-- Daytime result goes out immediately.
select tests.create_user('Day1', 'Asia/Tokyo');
select tests.create_user('Day2', 'Asia/Tokyo');
select tests.pair('Day1', 'Day2', 'Daytime', '2026-10-22 00:30Z');
update public.pacts set current_streak = 2 where title = 'Daytime';
select tests.tap('Day1', tests.pact('Daytime'), '2026-10-22 01:00Z');
select public.evaluate_due_pacts('2026-10-23 01:00Z');  -- 10:00 Tokyo
select is((select count(*)::int from pg_temp.outbox(tests.pact('Daytime'))
            where kind = 'broken' and send_after = '2026-10-23 01:00Z'), 2,
          'a broken result outside quiet hours is due immediately');

-- Milestones at 7.
select tests.create_user('M1');
select tests.create_user('M2');
select tests.pair('M1', 'M2', 'Milestone', '2026-10-22 08:00Z');
update public.pacts set current_streak = 6, longest_streak = 6 where title = 'Milestone';
select tests.tap('M1', tests.pact('Milestone'), '2026-10-22 09:00Z');
select tests.tap('M2', tests.pact('Milestone'), '2026-10-22 10:00Z');
select public.evaluate_due_pacts('2026-10-23 00:15Z');
select results_eq($$select who, kind from pg_temp.outbox(tests.pact('Milestone')) where kind = 'milestone' order by who$$,
                  $$values ('M1'::text, 'milestone'::text), ('M2'::text, 'milestone'::text)$$,
                  'reaching 7 days queues a milestone push for every member');
select public.evaluate_due_pacts('2026-10-23 00:30Z');
select is((select count(*)::int from pg_temp.outbox(tests.pact('Milestone')) where kind = 'milestone'), 2,
          'milestone not repeated by later runs');

-- ---------------------------------------------------------------------------
-- Nudges
-- ---------------------------------------------------------------------------

select tests.create_user('N1');
select tests.create_user('N2');
select tests.pair('N1', 'N2', 'Nudge', '2026-10-22 08:00Z');
select tests.login('N1');
select private.nudge(tests.pact('Nudge'), tests.uid('N2'), '2026-10-22 12:00Z');
select private.nudge(tests.pact('Nudge'), tests.uid('N2'), '2026-10-22 13:00Z');
select throws_ok(format('select private.nudge(%L, %L, %L)', tests.pact('Nudge'), tests.uid('N2'), '2026-10-22 14:00Z'),
                 'P0001', 'rate_limited', 'a third nudge from the same sender on the same day -> rate_limited');
select results_eq($$select who, kind, send_after from pg_temp.outbox(tests.pact('Nudge'))$$,
                  $$values ('N2'::text, 'nudge'::text, '2026-10-22 12:00Z'::timestamptz),
                           ('N2'::text, 'nudge'::text, '2026-10-22 13:00Z'::timestamptz)$$,
                  'two nudges delivered immediately');

select * from finish();
rollback;
