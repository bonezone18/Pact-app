-- Phase 6: the outbox as the sender sees it.
begin;
select plan(21);

select tests.create_user('Alice', 'America/New_York');
select tests.create_user('Bob', 'America/Los_Angeles');
select tests.pair('Alice', 'Bob', 'Walk', '2026-10-22 14:00Z');
insert into public.push_tokens (token, user_id, platform) values
  ('ExponentPushToken[bob-phone]', tests.uid('Bob'), 'ios'),
  ('ExponentPushToken[bob-tablet]', tests.uid('Bob'), 'android');

create function pg_temp.claim(at timestamptz, n int default 100)
returns table (id bigint, who text, kind text, attempts smallint, tokens text[])
language sql as $$
  select c.id, pr.display_name, c.kind, c.attempts, c.tokens
    from private.claim_notifications(n, at) c join public.profiles pr on pr.id = c.user_id;
$$;

-- ---------------------------------------------------------------------------
-- Partner check-in reaches the pending member on the next run (< 60 s)
-- ---------------------------------------------------------------------------

select tests.tap('Alice', tests.pact('Walk'), '2026-10-22 15:00:00Z');
select results_eq(
  $$select who, kind, attempts, tokens from pg_temp.claim('2026-10-22 15:00:59Z')$$,
  $$values ('Bob'::text, 'partner_checked_in'::text, 1::smallint,
            array['ExponentPushToken[bob-phone]', 'ExponentPushToken[bob-tablet]'])$$,
  'a partner check-in is claimable by the very next run, with all of Bob''s devices');

-- ---------------------------------------------------------------------------
-- Leases, retries, attempts
-- ---------------------------------------------------------------------------

select is_empty($$select * from pg_temp.claim('2026-10-22 15:01:30Z')$$,
                'a claimed row is leased: an overlapping run does not get it');
select results_eq($$select attempts from pg_temp.claim('2026-10-22 15:03:00Z')$$,
                  $$values (2::smallint)$$,
                  'an expired lease (sender crashed) is reclaimed as a new attempt');

select private.release_notifications(array(select id from public.notification_outbox where kind = 'partner_checked_in'),
                                     'Expo 500');
select is((select last_error from public.notification_outbox where kind = 'partner_checked_in'), 'Expo 500',
          'release records why');
select results_eq($$select attempts from pg_temp.claim('2026-10-22 15:03:10Z')$$,
                  $$values (3::smallint)$$,
                  'a released row is retried on the next run');
select private.release_notifications(array(select id from public.notification_outbox where kind = 'partner_checked_in'), 'again');
select is_empty($$select * from pg_temp.claim('2026-10-22 15:10:00Z')$$,
                'after 3 attempts the row is not retried again');

-- ---------------------------------------------------------------------------
-- Sent rows are done
-- ---------------------------------------------------------------------------

select private.nudge(tests.pact('Walk'), tests.uid('Bob'), '2026-10-22 16:00Z');  -- Alice is logged in
select set_config('t.nudge', (select id::text from pg_temp.claim('2026-10-22 16:00:30Z') where kind = 'nudge'), true);
select ok(current_setting('t.nudge') <> '', 'nudge claimed');
select private.mark_notifications_sent(array[current_setting('t.nudge')::bigint], '2026-10-22 16:00:31Z');
select results_eq($$select sent_at, claimed_until from public.notification_outbox where kind = 'nudge'$$,
                  $$values ('2026-10-22 16:00:31Z'::timestamptz, null::timestamptz)$$,
                  'marked sent');
select is_empty($$select * from pg_temp.claim('2026-10-22 16:05:00Z') where kind = 'nudge'$$,
                'a sent row is never claimed again');
select private.release_notifications(array[current_setting('t.nudge')::bigint], 'late failure');
select is((select sent_at from public.notification_outbox where kind = 'nudge'), '2026-10-22 16:00:31Z'::timestamptz,
          'releasing a sent row cannot resurrect it');

-- ---------------------------------------------------------------------------
-- Quiet hours: a 03:15 result waits for 08:00 local
-- ---------------------------------------------------------------------------

update public.pacts set current_streak = 4, longest_streak = 4, last_evaluated_date = '2026-10-21' where title = 'Walk';
delete from public.check_ins where user_id = tests.uid('Bob');
select public.evaluate_due_pacts('2026-10-23 07:15Z');  -- LA 00:15, NY 03:15; Bob missed Oct 22
select is_empty($$select * from pg_temp.claim('2026-10-23 11:59Z') where kind = 'broken' and who = 'Alice'$$,
                'Alice''s broken push is not sent at night');
select results_eq($$select who from pg_temp.claim('2026-10-23 12:00Z') where kind = 'broken'$$,
                  $$values ('Alice'::text)$$,
                  'it goes out at 08:00 New York time');
select private.mark_notifications_sent(array(select id from public.notification_outbox where kind = 'broken'
                                               and user_id = tests.uid('Alice')), '2026-10-23 12:00Z');
select results_eq($$select who from pg_temp.claim('2026-10-23 15:00Z') where kind = 'broken'$$,
                  $$values ('Bob'::text)$$,
                  'and Bob''s at 08:00 Los Angeles time');

-- ---------------------------------------------------------------------------
-- Batches, users without devices, dead tokens
-- ---------------------------------------------------------------------------

insert into public.notification_outbox (user_id, kind, payload, dedupe_key, send_after)
select tests.uid('Alice'), 'nudge', '{}', 'batch:' || g, '2026-10-24 00:00Z' from generate_series(1, 5) g;
select is((select count(*)::int from pg_temp.claim('2026-10-24 00:00Z', 3)), 3, 'claims at most max_rows');
select is((select tokens from pg_temp.claim('2026-10-24 00:00Z', 1) limit 1), '{}'::text[],
          'a user without devices comes back with no tokens (the sender just marks it done)');

select is(private.drop_push_tokens(array['ExponentPushToken[bob-tablet]', 'ExponentPushToken[unknown]']), 1,
          'dead tokens are dropped');
select results_eq($$select token from public.push_tokens$$, $$values ('ExponentPushToken[bob-phone]'::text)$$,
                  'other devices are kept');

-- ---------------------------------------------------------------------------
-- Who can call what; schedules
-- ---------------------------------------------------------------------------

select ok(has_function_privilege('service_role', 'public.claim_notifications(integer)', 'execute'),
          'the sender (service role) can claim');
select ok(not has_function_privilege('authenticated', 'public.claim_notifications(integer)', 'execute')
          and not has_function_privilege('anon', 'public.claim_notifications(integer)', 'execute')
          and not has_function_privilege('authenticated', 'public.mark_notifications_sent(bigint[])', 'execute')
          and not has_function_privilege('authenticated', 'public.drop_push_tokens(text[])', 'execute'),
          'clients cannot touch the sender functions');
select results_eq($$select schedule from cron.job where jobname = 'send-notifications'$$,
                  $$values ('* * * * *'::text)$$,
                  'the sender runs every minute');
select ok((select command from cron.job where jobname = 'send-notifications') like '%vault.decrypted_secrets%',
          'the schedule reads its URL and secret from Vault, not from the migration');

select * from finish();
rollback;
