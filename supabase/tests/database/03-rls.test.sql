-- Phase 2 acceptance: a non-member can't read any pact row, photo, or
-- profile, and clients can't write game state directly.
--
-- Cast:
--   alice  aaaaaaaa-…-001  owner of pact P1
--   bob    aaaaaaaa-…-002  member of pact P1
--   carol  aaaaaaaa-…-003  outsider (owner of her own pact P2)
begin;
create extension if not exists pgtap with schema extensions;
select plan(68);

-- ---------------------------------------------------------------------------
-- Fixtures (as the table owner, the way security-definer RPCs will write)
-- ---------------------------------------------------------------------------

insert into auth.users (id, email, raw_user_meta_data) values
  ('aaaaaaaa-0000-4000-8000-000000000001', 'alice@example.com', '{"full_name": "Alice"}'),
  ('aaaaaaaa-0000-4000-8000-000000000002', 'bob@example.com',   '{"full_name": "Bob"}'),
  ('aaaaaaaa-0000-4000-8000-000000000003', 'carol@example.com', '{"full_name": "Carol"}');

insert into public.pacts (id, title, proof_mode, status, created_by, start_date, current_streak, longest_streak) values
  ('bbbbbbbb-0000-4000-8000-000000000001', 'Walk 1 mile', 'photo', 'active',
   'aaaaaaaa-0000-4000-8000-000000000001', '2026-10-01', 5, 5),
  ('bbbbbbbb-0000-4000-8000-000000000002', 'Read 10 pages', 'tap', 'pending',
   'aaaaaaaa-0000-4000-8000-000000000003', null, 0, 0);

insert into public.pact_members (pact_id, user_id, role, first_required_date) values
  ('bbbbbbbb-0000-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-000000000001', 'owner',  '2026-10-01'),
  ('bbbbbbbb-0000-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-000000000002', 'member', '2026-10-01'),
  ('bbbbbbbb-0000-4000-8000-000000000002', 'aaaaaaaa-0000-4000-8000-000000000003', 'owner',  '2026-10-22');

insert into public.pact_invites (code, pact_id, created_by) values
  ('K7MQ2X', 'bbbbbbbb-0000-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-000000000001');

insert into public.check_ins (id, pact_id, user_id, local_date, timezone, image_path, captured_at) values
  ('cccccccc-0000-4000-8000-000000000001', 'bbbbbbbb-0000-4000-8000-000000000001',
   'aaaaaaaa-0000-4000-8000-000000000001', '2026-10-22', 'UTC',
   'bbbbbbbb-0000-4000-8000-000000000001/aaaaaaaa-0000-4000-8000-000000000001/dddddddd-0000-4000-8000-000000000001.jpg',
   now()),
  ('cccccccc-0000-4000-8000-000000000002', 'bbbbbbbb-0000-4000-8000-000000000001',
   'aaaaaaaa-0000-4000-8000-000000000002', '2026-10-22', 'UTC',
   'bbbbbbbb-0000-4000-8000-000000000001/aaaaaaaa-0000-4000-8000-000000000002/dddddddd-0000-4000-8000-000000000002.jpg',
   now());

insert into public.reactions (check_in_id, user_id, kind) values
  ('cccccccc-0000-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-000000000002', 'fire');

insert into public.streak_events (pact_id, local_date, outcome, streak_before, streak_after) values
  ('bbbbbbbb-0000-4000-8000-000000000001', '2026-10-21', 'extended', 4, 5);

insert into public.entitlements (user_id, is_pro) values
  ('aaaaaaaa-0000-4000-8000-000000000001', true);

insert into public.notification_outbox (user_id, kind, payload, dedupe_key) values
  ('aaaaaaaa-0000-4000-8000-000000000001', 'nudge', '{}', 'nudge:test');

insert into public.push_tokens (token, user_id, platform) values
  ('ExponentPushToken[alice]', 'aaaaaaaa-0000-4000-8000-000000000001', 'ios');

insert into storage.objects (bucket_id, name, owner) values
  ('proofs', 'bbbbbbbb-0000-4000-8000-000000000001/aaaaaaaa-0000-4000-8000-000000000001/dddddddd-0000-4000-8000-000000000001.jpg',
   'aaaaaaaa-0000-4000-8000-000000000001'),
  ('proofs', 'bbbbbbbb-0000-4000-8000-000000000001/aaaaaaaa-0000-4000-8000-000000000002/dddddddd-0000-4000-8000-000000000002.jpg',
   'aaaaaaaa-0000-4000-8000-000000000002'),
  ('avatars', 'aaaaaaaa-0000-4000-8000-000000000001/avatar.jpg', 'aaaaaaaa-0000-4000-8000-000000000001');

-- ---------------------------------------------------------------------------
-- Carol, a non-member, can read nothing of pact P1
-- ---------------------------------------------------------------------------

set local role authenticated;
set local "request.jwt.claims" to '{"sub": "aaaaaaaa-0000-4000-8000-000000000003", "role": "authenticated"}';

select is_empty($$select 1 from public.pacts where id = 'bbbbbbbb-0000-4000-8000-000000000001'$$,
                'non-member cannot read the pact');
select is_empty($$select 1 from public.pact_members where pact_id = 'bbbbbbbb-0000-4000-8000-000000000001'$$,
                'non-member cannot read its members');
select is_empty($$select 1 from public.check_ins where pact_id = 'bbbbbbbb-0000-4000-8000-000000000001'$$,
                'non-member cannot read its check-ins');
select is_empty($$select 1 from public.reactions$$,
                'non-member cannot read its reactions');
select is_empty($$select 1 from public.streak_events where pact_id = 'bbbbbbbb-0000-4000-8000-000000000001'$$,
                'non-member cannot read its streak events');
select is_empty($$select 1 from public.pact_invites where pact_id = 'bbbbbbbb-0000-4000-8000-000000000001'$$,
                'non-member cannot read its invite codes');
select is_empty($$select 1 from storage.objects where bucket_id = 'proofs'$$,
                'non-member cannot read its photos');
select is_empty($$select 1 from public.profiles
                   where id in ('aaaaaaaa-0000-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-000000000002')$$,
                'non-member cannot read its members'' profiles');
select is_empty($$select 1 from storage.objects where bucket_id = 'avatars'$$,
                'non-member cannot read its members'' avatars');
select is_empty($$select 1 from public.entitlements$$,
                'cannot read another user''s entitlement');
select is_empty($$select 1 from public.push_tokens$$,
                'cannot read another user''s push tokens');
select throws_ok($$select 1 from public.notification_outbox$$, '42501', null,
                 'notification_outbox is not readable by clients');

-- Positive controls: Carol still sees her own things.
select results_eq($$select display_name from public.profiles$$, $$values ('Carol'::text)$$,
                  'user sees only their own profile');
select results_eq($$select id from public.pacts$$,
                  $$values ('bbbbbbbb-0000-4000-8000-000000000002'::uuid)$$,
                  'user sees only their own pact');

-- Carol cannot plant a photo in someone else's pact.
select throws_ok(
  $$insert into storage.objects (bucket_id, name) values ('proofs',
    'bbbbbbbb-0000-4000-8000-000000000001/aaaaaaaa-0000-4000-8000-000000000003/x.jpg')$$,
  '42501', null, 'non-member cannot upload into a pact''s proofs');

reset role;

-- ---------------------------------------------------------------------------
-- Alice, a member, can read everything in P1
-- ---------------------------------------------------------------------------

set local role authenticated;
set local "request.jwt.claims" to '{"sub": "aaaaaaaa-0000-4000-8000-000000000001", "role": "authenticated"}';

select results_eq($$select id from public.pacts$$,
                  $$values ('bbbbbbbb-0000-4000-8000-000000000001'::uuid)$$,
                  'member reads their pact (and only theirs)');
select is((select count(*)::int from public.pact_members), 2, 'member reads both memberships');
select is((select count(*)::int from public.check_ins), 2, 'member reads all check-ins in the pact');
select is((select count(*)::int from public.reactions), 1, 'member reads reactions');
select is((select count(*)::int from public.streak_events), 1, 'member reads streak events');
select is((select count(*)::int from public.pact_invites), 1, 'member reads the invite code');
select is((select count(*)::int from storage.objects where bucket_id = 'proofs'), 2,
          'member reads every proof photo in the pact');
select results_eq($$select display_name from public.profiles order by display_name$$,
                  $$values ('Alice'::text), ('Bob'::text)$$,
                  'member reads pact-mates'' profiles but not outsiders''');
select is((select count(*)::int from public.entitlements), 1, 'user reads their own entitlement');
select is((select count(*)::int from public.push_tokens), 1, 'user reads their own push tokens');

-- ---------------------------------------------------------------------------
-- Direct writes to game state fail, even for members
-- ---------------------------------------------------------------------------

select throws_ok(
  $$insert into public.pacts (title, created_by) values ('Sneaky', 'aaaaaaaa-0000-4000-8000-000000000001')$$,
  '42501', null, 'cannot insert a pact directly');
select throws_ok(
  $$update public.pacts set current_streak = 99 where id = 'bbbbbbbb-0000-4000-8000-000000000001'$$,
  '42501', null, 'cannot update current_streak');
select throws_ok(
  $$update public.pacts set longest_streak = 99 where id = 'bbbbbbbb-0000-4000-8000-000000000001'$$,
  '42501', null, 'cannot update longest_streak');
select throws_ok(
  $$update public.pacts set status = 'archived' where id = 'bbbbbbbb-0000-4000-8000-000000000001'$$,
  '42501', null, 'cannot update pact status');
select throws_ok(
  $$delete from public.pacts where id = 'bbbbbbbb-0000-4000-8000-000000000001'$$,
  '42501', null, 'cannot delete a pact');

select throws_ok(
  $$insert into public.check_ins (pact_id, user_id, local_date, timezone, captured_at) values
    ('bbbbbbbb-0000-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-000000000001', '2026-10-21', 'UTC', now())$$,
  '42501', null, 'cannot insert a (backdated) check-in directly');
select throws_ok(
  $$update public.check_ins set image_path = null where id = 'cccccccc-0000-4000-8000-000000000002'$$,
  '42501', null, 'cannot update another user''s check-in');
select throws_ok(
  $$update public.check_ins set local_date = '2026-10-20' where id = 'cccccccc-0000-4000-8000-000000000001'$$,
  '42501', null, 'cannot move own check-in to another date');
select throws_ok(
  $$delete from public.check_ins where id = 'cccccccc-0000-4000-8000-000000000002'$$,
  '42501', null, 'cannot delete another user''s check-in');

select throws_ok(
  $$insert into public.pact_members (pact_id, user_id, first_required_date) values
    ('bbbbbbbb-0000-4000-8000-000000000002', 'aaaaaaaa-0000-4000-8000-000000000001', '2026-10-22')$$,
  '42501', null, 'cannot add self to a pact directly');
select throws_ok(
  $$update public.pact_members set left_at = now() where user_id = 'aaaaaaaa-0000-4000-8000-000000000002'$$,
  '42501', null, 'cannot change memberships directly');
select throws_ok(
  $$insert into public.pact_invites (code, pact_id, created_by) values
    ('ABCDEF', 'bbbbbbbb-0000-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-000000000001')$$,
  '42501', null, 'cannot create invites directly');
select throws_ok(
  $$insert into public.streak_events (pact_id, local_date, outcome, streak_before, streak_after) values
    ('bbbbbbbb-0000-4000-8000-000000000001', '2026-10-22', 'extended', 5, 6)$$,
  '42501', null, 'cannot write streak events');
select throws_ok(
  $$delete from public.streak_events$$,
  '42501', null, 'cannot delete streak events');
select throws_ok(
  $$insert into public.reactions (check_in_id, user_id, kind) values
    ('cccccccc-0000-4000-8000-000000000002', 'aaaaaaaa-0000-4000-8000-000000000001', 'fire')$$,
  '42501', null, 'cannot write reactions directly');
select throws_ok(
  $$update public.entitlements set is_pro = true$$,
  '42501', null, 'cannot grant self Pro');
select throws_ok(
  $$insert into public.entitlements (user_id, is_pro) values ('aaaaaaaa-0000-4000-8000-000000000003', true)$$,
  '42501', null, 'cannot create entitlements');
select throws_ok(
  $$insert into public.notification_outbox (user_id, kind, payload, dedupe_key) values
    ('aaaaaaaa-0000-4000-8000-000000000002', 'nudge', '{}', 'spam')$$,
  '42501', null, 'cannot enqueue notifications directly');

-- Profiles: name and avatar are editable, everything else is server-owned.
select lives_ok(
  $$update public.profiles set display_name = 'Alice B' where id = 'aaaaaaaa-0000-4000-8000-000000000001'$$,
  'can rename own profile');
select throws_ok(
  $$update public.profiles set timezone = 'Pacific/Kiritimati' where id = 'aaaaaaaa-0000-4000-8000-000000000001'$$,
  '42501', null, 'cannot change own timezone directly (set_timezone RPC only)');
select throws_ok(
  $$update public.profiles set pending_timezone = 'Pacific/Kiritimati' where id = 'aaaaaaaa-0000-4000-8000-000000000001'$$,
  '42501', null, 'cannot set pending_timezone directly');
select throws_ok(
  $$insert into public.profiles (id, display_name) values ('aaaaaaaa-0000-4000-8000-000000000009', 'Ghost')$$,
  '42501', null, 'cannot insert profiles directly');
update public.profiles set display_name = 'Hacked' where id = 'aaaaaaaa-0000-4000-8000-000000000002';

-- Push tokens: own rows only.
select lives_ok(
  $$insert into public.push_tokens (token, user_id, platform)
    values ('ExponentPushToken[alice-2]', 'aaaaaaaa-0000-4000-8000-000000000001', 'android')$$,
  'can register own push token');
select throws_ok(
  $$insert into public.push_tokens (token, user_id, platform)
    values ('ExponentPushToken[evil]', 'aaaaaaaa-0000-4000-8000-000000000002', 'ios')$$,
  '42501', null, 'cannot register a push token for someone else');

-- Storage: proofs go under {pact_id}/{own uid}/ only.
select lives_ok(
  $$insert into storage.objects (bucket_id, name) values ('proofs',
    'bbbbbbbb-0000-4000-8000-000000000001/aaaaaaaa-0000-4000-8000-000000000001/dddddddd-0000-4000-8000-000000000003.jpg')$$,
  'member can upload a proof under their own prefix');
select throws_ok(
  $$insert into storage.objects (bucket_id, name) values ('proofs',
    'bbbbbbbb-0000-4000-8000-000000000001/aaaaaaaa-0000-4000-8000-000000000002/forged.jpg')$$,
  '42501', null, 'member cannot upload under a partner''s prefix');
select throws_ok(
  $$insert into storage.objects (bucket_id, name) values ('proofs',
    'bbbbbbbb-0000-4000-8000-000000000002/aaaaaaaa-0000-4000-8000-000000000001/x.jpg')$$,
  '42501', null, 'member cannot upload into a pact they are not in');
select throws_ok(
  $$insert into storage.objects (bucket_id, name) values ('proofs',
    'bbbbbbbb-0000-4000-8000-000000000001/aaaaaaaa-0000-4000-8000-000000000001/nested/x.jpg')$$,
  '42501', null, 'proof paths must be exactly {pact}/{user}/{file}');
select throws_ok(
  $$insert into storage.objects (bucket_id, name) values ('proofs', 'not-a-uuid/x.jpg')$$,
  '42501', null, 'malformed proof paths are rejected, not errors');
select throws_ok(
  $$update storage.objects set name = 'bbbbbbbb-0000-4000-8000-000000000001/aaaaaaaa-0000-4000-8000-000000000002/moved.jpg'
     where name like '%/dddddddd-0000-4000-8000-000000000003.jpg'$$,
  '42501', null, 'cannot move a proof under a partner''s prefix');

delete from storage.objects
 where name = 'bbbbbbbb-0000-4000-8000-000000000001/aaaaaaaa-0000-4000-8000-000000000001/dddddddd-0000-4000-8000-000000000001.jpg';
delete from storage.objects
 where name = 'bbbbbbbb-0000-4000-8000-000000000001/aaaaaaaa-0000-4000-8000-000000000002/dddddddd-0000-4000-8000-000000000002.jpg';
select lives_ok(
  $$delete from storage.objects where name like '%/dddddddd-0000-4000-8000-000000000003.jpg'$$,
  'member can delete their own orphan upload');

-- Avatars: own folder only.
select lives_ok(
  $$insert into storage.objects (bucket_id, name) values ('avatars', 'aaaaaaaa-0000-4000-8000-000000000001/new.jpg')$$,
  'user can upload their own avatar');
select throws_ok(
  $$insert into storage.objects (bucket_id, name) values ('avatars', 'aaaaaaaa-0000-4000-8000-000000000002/new.jpg')$$,
  '42501', null, 'user cannot upload someone else''s avatar');

reset role;

-- ---------------------------------------------------------------------------
-- Nothing above changed game state
-- ---------------------------------------------------------------------------

select results_eq(
  $$select status::text, current_streak, longest_streak from public.pacts
     where id = 'bbbbbbbb-0000-4000-8000-000000000001'$$,
  $$values ('active'::text, 5, 5)$$,
  'pact state unchanged');
select is((select count(*)::int from public.check_ins), 2, 'check-ins unchanged');
select is((select display_name from public.profiles where id = 'aaaaaaaa-0000-4000-8000-000000000002'),
          'Bob', 'a member cannot rename their partner');
select is((select display_name from public.profiles where id = 'aaaaaaaa-0000-4000-8000-000000000001'),
          'Alice B', 'own rename applied');
select is((select count(*)::int from storage.objects where bucket_id = 'proofs'), 2,
          'proofs backing check-ins cannot be deleted by anyone');

-- ---------------------------------------------------------------------------
-- Leaving a pact revokes access; anon sees nothing
-- ---------------------------------------------------------------------------

update public.pact_members set left_at = now()
 where pact_id = 'bbbbbbbb-0000-4000-8000-000000000001' and user_id = 'aaaaaaaa-0000-4000-8000-000000000002';

set local role authenticated;
set local "request.jwt.claims" to '{"sub": "aaaaaaaa-0000-4000-8000-000000000002", "role": "authenticated"}';
select is_empty($$select 1 from public.check_ins$$, 'a member who left loses access to check-ins');
select is_empty($$select 1 from storage.objects where bucket_id = 'proofs'$$,
                'a member who left loses access to photos');
reset role;

set local role anon;
set local "request.jwt.claims" to '{"role": "anon"}';
select throws_ok($$select 1 from public.pacts$$, '42501', null, 'anon cannot read pacts');
select throws_ok($$select 1 from public.profiles$$, '42501', null, 'anon cannot read profiles');
select is_empty($$select 1 from storage.objects$$, 'anon cannot read any stored object');
reset role;

select * from finish();
rollback;
