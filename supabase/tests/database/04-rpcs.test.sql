-- Game RPCs: pairing, invites, membership, monetization limits, reactions,
-- nudges, account actions and who may call what.
begin;
select plan(68);

select tests.create_user('Alice');
select tests.create_user('Bob');
select tests.create_user('Carol');
select tests.create_user('Dave');
select tests.create_user('Erin', 'Asia/Tokyo');

-- ---------------------------------------------------------------------------
-- create_pact
-- ---------------------------------------------------------------------------

select tests.login('Alice');
select set_config('t.created', private.create_pact('  Walk 1 mile ', 'photo', 2, '2026-10-22 08:00Z')::text, true);

select ok(current_setting('t.created')::jsonb ->> 'code' ~ '^[A-HJKMNP-Z2-9]{6}$', 'create_pact returns a valid invite code');
select results_eq(
  $$select title, status::text, proof_mode::text, max_members::int, created_by from public.pacts$$,
  $$values ('Walk 1 mile'::text, 'pending'::text, 'photo'::text, 2, tests.uid('Alice'))$$,
  'pact created pending with a trimmed title');
select results_eq(
  $$select user_id, role from public.pact_members$$,
  $$values (tests.uid('Alice'), 'owner'::text)$$,
  'creator is the owner');
select is((select expires_at from public.pact_invites), '2026-10-29 08:00Z'::timestamptz,
          'invite valid for 7 days');

select throws_ok($$select private.create_pact(repeat('x', 41), 'tap', 2, now())$$,
                 'P0001', 'invalid_title', 'title over 40 chars rejected');
select throws_ok($$select private.create_pact('   ', 'tap', 2, now())$$,
                 'P0001', 'invalid_title', 'blank title rejected');
select throws_ok($$select private.create_pact('Gym', 'tap', 5, now())$$,
                 'P0001', 'invalid_pod_size', 'pod of 5 rejected');
select set_config('request.jwt.claims', '', true);
select throws_ok($$select private.create_pact('Gym', 'tap', 2, now())$$,
                 'P0001', 'not_authenticated', 'anonymous callers rejected');

-- ---------------------------------------------------------------------------
-- join_pact
-- ---------------------------------------------------------------------------

select tests.login('Bob');
select throws_ok($$select private.join_pact('ZZZZZZ', '2026-10-22 09:00Z')$$,
                 'P0001', 'invalid_code', 'unknown code rejected');
select throws_ok(format('select private.join_pact(%L, %L)',
                        current_setting('t.created')::jsonb ->> 'code', '2026-10-29 08:00Z'),
                 'P0001', 'expired_code', 'code rejected once 7 days have passed');

select tests.login('Alice');
select throws_ok(format('select private.join_pact(%L, %L)',
                        current_setting('t.created')::jsonb ->> 'code', '2026-10-22 09:00Z'),
                 'P0001', 'already_member', 'creator cannot join their own pact');

-- Codes are case-insensitive and the display hyphen is ignored.
select tests.login('Bob');
select is(
  private.join_pact(lower(substr(current_setting('t.created')::jsonb ->> 'code', 1, 3) || '-' ||
                          substr(current_setting('t.created')::jsonb ->> 'code', 4)),
                    '2026-10-22 09:00Z') ->> 'status',
  'active', 'second member activates the pact (code typed as k7m-q2x)');
select results_eq(
  $$select status::text, start_date from public.pacts$$,
  $$values ('active'::text, '2026-10-22'::date)$$,
  'start_date is the activation date');
select results_eq(
  $$select user_id, first_required_date from public.pact_members order by role desc$$,
  $$values (tests.uid('Alice'), '2026-10-22'::date), (tests.uid('Bob'), '2026-10-22'::date)$$,
  'founders are both first required on the start date');

select tests.login('Carol');
select throws_ok(format('select private.join_pact(%L, %L)',
                        current_setting('t.created')::jsonb ->> 'code', '2026-10-22 10:00Z'),
                 'P0001', 'pact_full', 'third member cannot join a pair');

-- ---------------------------------------------------------------------------
-- regenerate_invite
-- ---------------------------------------------------------------------------

select throws_ok(format('select private.regenerate_invite(%L, now())', tests.pact('Walk 1 mile')),
                 'P0001', 'not_member', 'non-member cannot regenerate the code');

select tests.login('Alice');
select set_config('t.new_code',
  private.regenerate_invite(tests.pact('Walk 1 mile'), '2026-10-23 08:00Z') ->> 'code', true);
select isnt(current_setting('t.new_code'), current_setting('t.created')::jsonb ->> 'code',
            'regenerate issues a different code');
select is((select count(*)::int from public.pact_invites where revoked_at is null), 1,
          'exactly one live code per pact');
select tests.login('Dave');
select throws_ok(format('select private.join_pact(%L, %L)',
                        current_setting('t.created')::jsonb ->> 'code', '2026-10-23 09:00Z'),
                 'P0001', 'invalid_code', 'revoked code rejected');

-- ---------------------------------------------------------------------------
-- Monetization limits
-- ---------------------------------------------------------------------------

select tests.login('Alice');
select throws_ok($$select private.create_pact('Read 10 pages', 'tap', 2, '2026-10-23 09:00Z')$$,
                 'P0001', 'pro_required', 'free user with an active pact cannot create a second');

select tests.login('Carol');
select set_config('t.carol', private.create_pact('Meditate 10 min', 'tap', 2, '2026-10-23 09:00Z')::text, true);
select throws_ok(format('select private.join_pact(%L, %L)',
                        current_setting('t.carol')::jsonb ->> 'code', '2026-10-23 09:00Z'),
                 'P0001', 'already_member', 'sanity: Carol owns her pending pact');
select tests.login('Alice');
select throws_ok(format('select private.join_pact(%L, %L)',
                        current_setting('t.carol')::jsonb ->> 'code', '2026-10-23 09:00Z'),
                 'P0001', 'pro_required', 'free user with an active pact cannot join a second');

select tests.login('Dave');
select throws_ok($$select private.create_pact('Gym', 'tap', 3, '2026-10-23 09:00Z')$$,
                 'P0001', 'pro_required', 'free user cannot create a 3-person pod');
select tests.grant_pro('Dave');
select lives_ok($$select private.create_pact('Gym', 'tap', 3, '2026-10-23 09:00Z')$$,
                'Pro user can create a 3-person pod');
select lives_ok($$select private.create_pact('No sugar', 'tap', 2, '2026-10-23 09:00Z')$$,
                'Pro user can hold more than one pact');

update public.entitlements set expires_at = '2026-10-23 00:00Z' where user_id = tests.uid('Dave');
select throws_ok($$select private.create_pact('Pushups', 'tap', 2, '2026-10-23 09:00Z')$$,
                 'P0001', 'pro_required', 'expired entitlement counts as free');
update public.entitlements set expires_at = null where user_id = tests.uid('Dave');

-- ---------------------------------------------------------------------------
-- Pods: mid-day join, downgrade, leaving
-- ---------------------------------------------------------------------------

-- Carol leaves her pending pact so she is free to join Dave's pod.
select tests.login('Carol');
select is(private.leave_pact(tests.pact('Meditate 10 min'), '2026-10-23 09:30Z') ->> 'status',
          'archived', 'leaving a pending pact archives it');

select tests.login('Dave');
select set_config('t.pod_code', private.regenerate_invite(tests.pact('Gym'), '2026-10-23 09:00Z') ->> 'code', true);
select tests.login('Carol');
select is(private.join_pact(current_setting('t.pod_code'), '2026-10-23 10:00Z') ->> 'status', 'active',
          'second member activates the pod');

-- Dave downgrades; the pod keeps going and can still fill its seats.
update public.entitlements set is_pro = false where user_id = tests.uid('Dave');
select tests.login('Erin');  -- Tokyo: 2026-10-23 20:00Z is Oct 24 05:00 local
select lives_ok(format('select private.join_pact(%L, %L)', current_setting('t.pod_code'), '2026-10-23 20:00Z'),
                'joining a pod is free, even after the creator downgraded');
select is((select first_required_date from public.pact_members
            where pact_id = tests.pact('Gym') and user_id = tests.uid('Erin')),
          '2026-10-25'::date, 'mid-day joiner is first required the day after they join (their local date)');
select tests.login('Dave');
select throws_ok($$select private.create_pact('Pushups', 'tap', 2, '2026-10-23 21:00Z')$$,
                 'P0001', 'pro_required', 'downgraded user cannot create beyond the free limit');

select tests.login('Carol');
select is(private.leave_pact(tests.pact('Gym'), '2026-10-24 10:00Z') ->> 'status', 'active',
          'pod with 2+ remaining continues after a member leaves');
select throws_ok(format('select private.leave_pact(%L, now())', tests.pact('Gym')),
                 'P0001', 'not_member', 'cannot leave twice');

-- Leaving a pair archives it and frees the free slot.
select tests.login('Bob');
select is(private.leave_pact(tests.pact('Walk 1 mile'), '2026-10-24 10:00Z') ->> 'status', 'archived',
          'pair with one member left is archived');
select is((select count(*)::int from public.pact_invites
            where pact_id = tests.pact('Walk 1 mile') and revoked_at is null), 0,
          'archiving revokes the live invite');
select tests.login('Alice');
select lives_ok($$select private.create_pact('Read 10 pages', 'tap', 2, '2026-10-24 11:00Z')$$,
                'archived pacts no longer count toward the free limit');

-- ---------------------------------------------------------------------------
-- Reactions
-- ---------------------------------------------------------------------------

select tests.create_user('Fay');
select tests.create_user('Gus');
select tests.pair('Fay', 'Gus', 'Stretch', '2026-10-22 08:00Z');
select tests.tap('Fay', tests.pact('Stretch'), '2026-10-22 09:00Z');
select set_config('t.fay_ci', (select id::text from public.check_ins where user_id = tests.uid('Fay')), true);

select tests.login('Fay');
select throws_ok(format('select private.react(%L, %L, now())', current_setting('t.fay_ci'), 'fire'),
                 'P0001', 'own_check_in', 'cannot react to own check-in');
select tests.login('Alice');
select throws_ok(format('select private.react(%L, %L, now())', current_setting('t.fay_ci'), 'fire'),
                 'P0001', 'not_member', 'non-member cannot react');
select tests.login('Gus');
select throws_ok(format('select private.react(%L, %L, now())', current_setting('t.fay_ci'), 'poop'),
                 'P0001', 'invalid_kind', 'only preset reactions');
select lives_ok(format('select private.react(%L, %L, %L)', current_setting('t.fay_ci'), 'fire', '2026-10-22 09:05Z'),
                'partner reacts');
select lives_ok(format('select private.react(%L, %L, %L)', current_setting('t.fay_ci'), 'clap', '2026-10-22 09:06Z'),
                'partner changes their reaction');
select results_eq(
  format('select user_id, kind from public.reactions where check_in_id = %L', current_setting('t.fay_ci')),
  $$values (tests.uid('Gus'), 'clap'::text)$$,
  'one reaction per member per check-in (upserted)');
select is((select count(*)::int from public.notification_outbox
            where kind = 'reaction' and user_id = tests.uid('Fay')), 1,
          'a reactor only triggers one push per check-in');

-- ---------------------------------------------------------------------------
-- Nudges
-- ---------------------------------------------------------------------------

select tests.login('Fay');
select throws_ok(format('select private.nudge(%L, %L, %L)', tests.pact('Stretch'), tests.uid('Fay'), '2026-10-22 10:00Z'),
                 'P0001', 'not_member', 'cannot nudge yourself');
select throws_ok(format('select private.nudge(%L, %L, %L)', tests.pact('Stretch'), tests.uid('Alice'), '2026-10-22 10:00Z'),
                 'P0001', 'not_member', 'cannot nudge a non-member');
select lives_ok(format('select private.nudge(%L, %L, %L)', tests.pact('Stretch'), tests.uid('Gus'), '2026-10-22 10:00Z'),
                'first nudge');
select lives_ok(format('select private.nudge(%L, %L, %L)', tests.pact('Stretch'), tests.uid('Gus'), '2026-10-22 15:00Z'),
                'second nudge');
select throws_ok(format('select private.nudge(%L, %L, %L)', tests.pact('Stretch'), tests.uid('Gus'), '2026-10-22 18:00Z'),
                 'P0001', 'rate_limited', 'third nudge from the same sender on the same day is rate limited');
select is((select count(*)::int from public.notification_outbox where kind = 'nudge' and user_id = tests.uid('Gus')), 2,
          'two nudges queued');
select lives_ok(format('select private.nudge(%L, %L, %L)', tests.pact('Stretch'), tests.uid('Gus'), '2026-10-23 10:00Z'),
                'the limit resets on the sender''s next day');
select tests.tap('Gus', tests.pact('Stretch'), '2026-10-23 11:00Z');
select tests.login('Fay');
select throws_ok(format('select private.nudge(%L, %L, %L)', tests.pact('Stretch'), tests.uid('Gus'), '2026-10-23 12:00Z'),
                 'P0001', 'already_checked_in', 'cannot nudge someone who already checked in');

-- ---------------------------------------------------------------------------
-- set_reminders, set_timezone
-- ---------------------------------------------------------------------------

select lives_ok(format('select private.set_reminders(%L, false)', tests.pact('Stretch')), 'turn reminders off');
select is((select reminders_enabled from public.pact_members
            where pact_id = tests.pact('Stretch') and user_id = tests.uid('Fay')), false, 'reminders off for this pact');
select throws_ok(format('select private.set_reminders(%L, false)', tests.pact('Gym')),
                 'P0001', 'not_member', 'cannot toggle reminders in someone else''s pact');

select throws_ok($$select private.set_timezone('Mars/Olympus', now())$$,
                 'P0001', 'invalid_timezone', 'unknown timezone rejected');
select throws_ok($$select private.set_timezone('+05:30', now())$$,
                 'P0001', 'invalid_timezone', 'raw offsets rejected');

-- ---------------------------------------------------------------------------
-- delete_account
-- ---------------------------------------------------------------------------

select tests.login('Gus');
select lives_ok($$select private.delete_account('2026-10-24 12:00Z')$$, 'delete account');
select is(tests.uid('Gus'), null, 'profile removed');
select is((select status::text from public.pacts where id = tests.pact('Stretch')), 'archived',
          'their pair is archived for the partner');
select is((select count(*)::int from auth.users where email = 'gus@example.com'), 0, 'auth user removed');
select tests.login('Dave');
select lives_ok($$select private.delete_account('2026-10-24 12:00Z')$$,
                'a pact creator can delete their account');
select is((select created_by from public.pacts where title = 'Gym'), null,
          'their pacts survive with no creator');

-- ---------------------------------------------------------------------------
-- Who may call what
-- ---------------------------------------------------------------------------

select ok(has_function_privilege('authenticated', 'public.check_in(uuid, text, text, timestamptz)', 'execute'),
          'authenticated can call check_in');
select ok(not has_function_privilege('anon', 'public.check_in(uuid, text, text, timestamptz)', 'execute'),
          'anon cannot call check_in');
select ok(not has_function_privilege('authenticated', 'public.evaluate_due_pacts(timestamptz)', 'execute'),
          'clients cannot run the engine');
select ok(not has_function_privilege('authenticated', 'public.enqueue_reminders(timestamptz)', 'execute')
          and not has_function_privilege('authenticated', 'public.apply_pending_timezones(timestamptz)', 'execute')
          and not has_function_privilege('authenticated',
                'public.enqueue_day_result(uuid, date, text, integer, integer, uuid[], timestamptz)', 'execute'),
          'clients cannot run scheduled jobs');
select ok(not has_schema_privilege('authenticated', 'private', 'usage'),
          'clients cannot reach the clock-parameterised private functions');

-- The public wrapper works end to end through the authenticated role.
select tests.create_user('Hana');
select tests.login('Hana');
set local role authenticated;
select is(public.create_pact('Cold shower', 'tap') ->> 'pact_id' is not null, true,
          'public.create_pact works for an authenticated client');
reset role;

select * from finish();
rollback;
