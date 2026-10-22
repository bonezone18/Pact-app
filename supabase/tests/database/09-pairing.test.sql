-- Phase 4: invite previews for the landing page / join screen, and the
-- first-launch timezone.
begin;
select plan(17);

select tests.create_user('Alice');
select tests.create_user('Bob');
select tests.create_user('Carol');

select tests.login('Alice');
select set_config('t.code', private.create_pact('Walk 1 mile', 'photo', 2, '2026-10-22 08:00Z') ->> 'code', true);

-- ---------------------------------------------------------------------------
-- invite_preview
-- ---------------------------------------------------------------------------

select is(private.invite_preview(current_setting('t.code'), '2026-10-22 09:00Z') - 'expires_at',
          jsonb_build_object('status', 'valid', 'code', current_setting('t.code'), 'title', 'Walk 1 mile',
                             'proof_mode', 'photo', 'inviter_name', 'Alice',
                             'member_count', 1, 'max_members', 2),
          'valid code previews title, mode and inviter');
select is(private.invite_preview(lower(substr(current_setting('t.code'), 1, 3)) || '-' ||
                                 lower(substr(current_setting('t.code'), 4)), '2026-10-22 09:00Z') ->> 'status',
          'valid', 'preview accepts the display form (k7m-q2x)');
select is(private.invite_preview('ZZZZZZ', '2026-10-22 09:00Z'),
          '{"status": "invalid", "code": "ZZZZZZ"}'::jsonb, 'unknown code reveals nothing');
select is(private.invite_preview(current_setting('t.code'), '2026-10-29 08:00Z') ->> 'status',
          'expired', 'expired code previews as expired');
select ok(not (private.invite_preview(current_setting('t.code'), '2026-10-22 09:00Z') ?| array['pact_id', 'created_by']),
          'preview exposes no ids');

select tests.login('Bob');
select private.join_pact(current_setting('t.code'), '2026-10-22 10:00Z');
select is(private.invite_preview(current_setting('t.code'), '2026-10-22 11:00Z') ->> 'status',
          'full', 'full pact previews as full');

select tests.login('Alice');
select set_config('t.old', current_setting('t.code'), true);
select set_config('t.code', private.regenerate_invite(tests.pact('Walk 1 mile'), '2026-10-22 12:00Z') ->> 'code', true);
select is(private.invite_preview(current_setting('t.old'), '2026-10-22 12:00Z') ->> 'status',
          'invalid', 'revoked code previews as invalid');

select tests.login('Bob');
select private.leave_pact(tests.pact('Walk 1 mile'), '2026-10-22 13:00Z');
select is(private.invite_preview(current_setting('t.code'), '2026-10-22 13:00Z') ->> 'status',
          'invalid', 'code of an archived pact previews as invalid');

-- Signed-out visitors (the landing page) can call it; it is read-only.
select tests.login('Carol');
select set_config('t.carol', private.create_pact('Read 10 pages', 'tap', 2, now()) ->> 'code', true);
set local role anon;
select set_config('request.jwt.claims', '{"role": "anon"}', true);
select is(public.invite_preview(current_setting('t.carol')) ->> 'inviter_name', 'Carol',
          'anon can preview an invite');
select throws_ok(format('select public.join_pact(%L)', current_setting('t.carol')), '42501', null,
                 'anon still cannot join');
reset role;
select is(provolatile, 's', 'invite_preview is read-only (stable)')
  from pg_proc where oid = 'public.invite_preview(text)'::regprocedure;

-- ---------------------------------------------------------------------------
-- First-launch timezone
-- ---------------------------------------------------------------------------

select tests.create_user('Newbie');
select tests.login('Newbie');
select is(private.set_timezone('America/New_York', '2026-10-22 12:00Z') ->> 'timezone', 'America/New_York',
          'a user in no active pact gets the new zone immediately');
select results_eq($$select timezone, pending_timezone, timezone_changed_at from public.profiles
                     where display_name = 'Newbie'$$,
                  $$values ('America/New_York'::text, null::text, null::timestamptz)$$,
                  'applied directly, without spending the once-per-24h change');
select lives_ok($$select private.set_timezone('Europe/London', '2026-10-22 12:05Z')$$,
                'still adjustable before any pact is active');

-- A pending pact (waiting room) has nothing to protect either.
select private.create_pact('Gym', 'tap', 2, '2026-10-22 12:10Z');
select is(private.set_timezone('Asia/Tokyo', '2026-10-22 12:15Z') ->> 'timezone', 'Asia/Tokyo',
          'creator in the waiting room still switches immediately');

-- Once active, the travel rules from Phase 3 apply.
select tests.create_user('Mate');
select tests.login('Mate');
select private.join_pact((select code from public.pact_invites where pact_id = tests.pact('Gym')), '2026-10-22 12:20Z');
select tests.login('Newbie');
select is(private.set_timezone('America/Chicago', '2026-10-22 12:30Z') ->> 'pending_timezone', 'America/Chicago',
          'in an active pact the change waits for midnight');
select is((select timezone from public.profiles where display_name = 'Newbie'), 'Asia/Tokyo',
          'current zone unchanged until then');

select * from finish();
rollback;
