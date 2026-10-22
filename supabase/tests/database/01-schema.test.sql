-- Schema shape: every table exists, RLS is on everywhere, game-state tables
-- have no client write policies, and the core constraints hold.
begin;
create extension if not exists pgtap with schema extensions;
select plan(30);

select has_table('public', t, t || ' exists')
  from unnest(array['profiles','push_tokens','pacts','pact_members','pact_invites',
                    'check_ins','reactions','streak_events','entitlements',
                    'notification_outbox']) t;

select is(
  (select array_agg(c.relname::text order by c.relname) from pg_class c
    where c.relnamespace = 'public'::regnamespace and c.relkind = 'r' and not c.relrowsecurity),
  null,
  'RLS is enabled on every public table');

select is(
  (select count(*)::int from pg_policies
    where schemaname = 'public'
      and tablename in ('pacts','pact_members','check_ins','streak_events','entitlements',
                        'reactions','pact_invites')
      and cmd <> 'SELECT'),
  0,
  'game-state tables have no client write policies');

select is(
  (select count(*)::int from pg_policies
    where schemaname = 'public' and tablename = 'notification_outbox'),
  0,
  'notification_outbox has no client policies at all');

select has_function('public', 'is_member', array['uuid'], 'is_member(uuid) exists');
select is(
  (select prosecdef from pg_proc where oid = 'public.is_member(uuid)'::regprocedure),
  true, 'is_member is security definer');

select has_trigger('auth', 'users', 'on_auth_user_created', 'sign-up trigger exists');

-- Buckets
select results_eq(
  $$select id, public from storage.buckets where id in ('proofs','avatars') order by id$$,
  $$values ('avatars'::text, false), ('proofs'::text, false)$$,
  'proofs and avatars buckets exist and are private');

-- Fixtures for constraint checks (run as the table owner)
insert into auth.users (id, email) values
  ('aaaaaaaa-0000-4000-8000-000000000001', 'alice@example.com');
insert into public.pacts (id, title, created_by) values
  ('bbbbbbbb-0000-4000-8000-000000000001', 'Walk 1 mile', 'aaaaaaaa-0000-4000-8000-000000000001');

-- Invite codes: 6 chars from the unambiguous alphabet
select lives_ok(
  $$insert into public.pact_invites (code, pact_id, created_by)
    values ('K7MQ2X', 'bbbbbbbb-0000-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-000000000001')$$,
  'valid invite code accepted');
select throws_ok(
  $$insert into public.pact_invites (code, pact_id, created_by)
    values ('K7M0QX', 'bbbbbbbb-0000-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-000000000001')$$,
  '23514', null, 'invite code with 0 rejected');
select throws_ok(
  $$insert into public.pact_invites (code, pact_id, created_by)
    values ('K7MOQX', 'bbbbbbbb-0000-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-000000000001')$$,
  '23514', null, 'invite code with O rejected');
select throws_ok(
  $$insert into public.pact_invites (code, pact_id, created_by)
    values ('K7MIQX', 'bbbbbbbb-0000-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-000000000001')$$,
  '23514', null, 'invite code with I rejected');
select throws_ok(
  $$insert into public.pact_invites (code, pact_id, created_by)
    values ('K7MLQX', 'bbbbbbbb-0000-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-000000000001')$$,
  '23514', null, 'invite code with L rejected');
select throws_ok(
  $$insert into public.pact_invites (code, pact_id, created_by)
    values ('k7mq2y', 'bbbbbbbb-0000-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-000000000001')$$,
  '23514', null, 'lowercase invite code rejected');

-- Pacts
select throws_ok(
  $$insert into public.pacts (title, created_by)
    values (repeat('x', 41), 'aaaaaaaa-0000-4000-8000-000000000001')$$,
  '23514', null, 'pact title over 40 chars rejected');
select throws_ok(
  $$insert into public.pacts (title, max_members, created_by)
    values ('Gym', 5, 'aaaaaaaa-0000-4000-8000-000000000001')$$,
  '23514', null, 'pact with 5 members rejected');

-- Check-ins: one per member per local date
insert into public.check_ins (pact_id, user_id, local_date, timezone, captured_at) values
  ('bbbbbbbb-0000-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-000000000001',
   '2026-10-22', 'UTC', now());
select throws_ok(
  $$insert into public.check_ins (pact_id, user_id, local_date, timezone, captured_at) values
    ('bbbbbbbb-0000-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-000000000001',
     '2026-10-22', 'UTC', now())$$,
  '23505', null, 'second check-in on the same date rejected');
select throws_ok(
  $$insert into public.check_ins (pact_id, user_id, local_date, timezone, captured_at, note) values
    ('bbbbbbbb-0000-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-000000000001',
     '2026-10-23', 'UTC', now(), repeat('x', 81))$$,
  '23514', null, 'note over 80 chars rejected');

-- Streak events: one per pact day (the engine's idempotency guarantee)
insert into public.streak_events (pact_id, local_date, outcome, streak_before, streak_after) values
  ('bbbbbbbb-0000-4000-8000-000000000001', '2026-10-22', 'extended', 0, 1);
select throws_ok(
  $$insert into public.streak_events (pact_id, local_date, outcome, streak_before, streak_after)
    values ('bbbbbbbb-0000-4000-8000-000000000001', '2026-10-22', 'extended', 1, 2)$$,
  '23505', null, 'a pact day can only be evaluated once');

-- Timezones must be IANA names
select throws_ok(
  $$update public.profiles set timezone = 'Mars/Olympus' where id = 'aaaaaaaa-0000-4000-8000-000000000001'$$,
  '23514', null, 'unknown timezone rejected');
select lives_ok(
  $$update public.profiles set timezone = 'Asia/Kolkata' where id = 'aaaaaaaa-0000-4000-8000-000000000001'$$,
  'IANA timezone accepted');

select * from finish();
rollback;
