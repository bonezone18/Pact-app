-- Acceptance: check-ins (server-side rules; the offline queue is client work).
begin;
select plan(21);

select tests.create_user('Alice');
select tests.create_user('Bob');
select tests.create_user('Carol');
select tests.pair('Alice', 'Bob', 'Photo pact', '2026-10-22 08:00Z', 'photo');

create function pg_temp.proof(owner_name text, file text) returns text
language sql as $$
  select tests.pact('Photo pact') || '/' || tests.uid(owner_name) || '/' || file;
$$;

-- Uploaded objects (as storage would after a successful upload).
insert into storage.objects (bucket_id, name, owner) values
  ('proofs', pg_temp.proof('Alice', 'a1.jpg'), tests.uid('Alice')),
  ('proofs', pg_temp.proof('Bob', 'b1.jpg'), tests.uid('Bob'));

-- ---------------------------------------------------------------------------
-- Photo mode
-- ---------------------------------------------------------------------------

select tests.login('Alice');
select throws_ok(format('select private.check_in(%L, null, null, %L, %L)', tests.pact('Photo pact'),
                        '2026-10-22 09:00Z', '2026-10-22 09:00Z'),
                 'P0001', 'photo_required', 'photo-mode check-in without an image path -> photo_required');
select throws_ok(format('select private.check_in(%L, %L, null, %L, %L)', tests.pact('Photo pact'),
                        pg_temp.proof('Bob', 'b1.jpg'), '2026-10-22 09:00Z', '2026-10-22 09:00Z'),
                 'P0001', 'invalid_image_path', 'image path under another user''s prefix -> rejected');
select throws_ok(format('select private.check_in(%L, %L, null, %L, %L)', tests.pact('Photo pact'),
                        pg_temp.proof('Alice', 'never-uploaded.jpg'), '2026-10-22 09:00Z', '2026-10-22 09:00Z'),
                 'P0001', 'invalid_image_path', 'image path that was never uploaded -> rejected');
select throws_ok(format('select private.check_in(%L, %L, null, %L, %L)', tests.pact('Photo pact'),
                        '../' || pg_temp.proof('Alice', 'a1.jpg'), '2026-10-22 09:00Z', '2026-10-22 09:00Z'),
                 'P0001', 'invalid_image_path', 'path outside the {pact}/{user}/ prefix -> rejected');
select throws_ok(format('select private.check_in(%L, %L, %L, %L, %L)', tests.pact('Photo pact'),
                        pg_temp.proof('Alice', 'a1.jpg'), repeat('x', 81), '2026-10-22 09:00Z', '2026-10-22 09:00Z'),
                 'P0001', 'note_too_long', 'note over 80 chars rejected');

select is(private.check_in(tests.pact('Photo pact'), pg_temp.proof('Alice', 'a1.jpg'), '  Done!  ',
                           '2026-10-22 09:00Z', '2026-10-22 09:00Z') ->> 'local_date',
          '2026-10-22', 'valid photo check-in');
select results_eq($$select image_path, note, timezone from public.check_ins where user_id = tests.uid('Alice')$$,
                  $$values (pg_temp.proof('Alice', 'a1.jpg'), 'Done!'::text, 'UTC'::text)$$,
                  'stores the proof path, trimmed note and timezone snapshot');

select throws_ok(format('select private.check_in(%L, %L, null, %L, %L)', tests.pact('Photo pact'),
                        pg_temp.proof('Alice', 'a1.jpg'), '2026-10-22 10:00Z', '2026-10-22 10:00Z'),
                 'P0001', 'already_checked_in', 'second check-in on the same date -> already_checked_in');
select is((select count(*)::int from public.check_ins where user_id = tests.uid('Alice')), 1,
          'still one check-in');

select tests.login('Carol');
select throws_ok(format('select private.check_in(%L, null, null, null, %L)', tests.pact('Photo pact'), '2026-10-22 10:00Z'),
                 'P0001', 'not_member', 'non-member cannot check in');

-- ---------------------------------------------------------------------------
-- Tap mode, inactive pacts
-- ---------------------------------------------------------------------------

select tests.create_user('Dan');
select tests.create_user('Eve');
select tests.pair('Dan', 'Eve', 'Tap pact', '2026-10-22 08:00Z');
select tests.login('Dan');
select private.check_in(tests.pact('Tap pact'), 'ignored/path.jpg', null, '2026-10-22 09:00Z', '2026-10-22 09:00Z');
select is((select image_path from public.check_ins where user_id = tests.uid('Dan')), null,
          'tap mode ignores any image path');

select tests.login('Carol');
select set_config('t.pending', private.create_pact('Pending pact', 'tap', 2, '2026-10-22 08:00Z') ->> 'pact_id', true);
select throws_ok(format('select private.check_in(%L, null, null, null, %L)', current_setting('t.pending'), '2026-10-22 09:00Z'),
                 'P0001', 'pact_inactive', 'cannot check in before a partner joins');

-- ---------------------------------------------------------------------------
-- Offline grace: captured_at only matters within 20 minutes after midnight
-- ---------------------------------------------------------------------------

select tests.create_user('Gina');
select tests.create_user('Hal');
select tests.pair('Gina', 'Hal', 'Subway', '2026-10-22 08:00Z');

select tests.login('Gina');
select is(private.check_in(tests.pact('Subway'), null, null, '2026-10-22 23:58Z', '2026-10-23 00:10Z') ->> 'local_date',
          '2026-10-22', 'captured 23:58, arrives 00:10 -> counts for the previous date');
select tests.login('Hal');
select is(private.check_in(tests.pact('Subway'), null, null, '2026-10-22 23:30Z', '2026-10-23 00:10Z') ->> 'local_date',
          '2026-10-23', 'captured 23:30, arrives 00:10 -> grace exceeded, counts for today');

select tests.create_user('Ivy');
select tests.create_user('Jon');
select tests.pair('Ivy', 'Jon', 'Clock skew', '2026-10-22 08:00Z');
select tests.login('Ivy');
select is(private.check_in(tests.pact('Clock skew'), null, null, '2026-10-21 23:58Z', '2026-10-22 12:00Z') ->> 'local_date',
          '2026-10-22', 'an old captured_at outside the window is ignored');
select tests.login('Jon');
select is(private.check_in(tests.pact('Clock skew'), null, null, '2026-10-24 00:00Z', '2026-10-22 12:00Z') ->> 'local_date',
          '2026-10-22', 'a captured_at in the future is ignored');
select is((select captured_at from public.check_ins where user_id = tests.uid('Jon')), '2026-10-22 12:00Z'::timestamptz,
          'future captured_at is clamped to server time');

-- ---------------------------------------------------------------------------
-- Through the client role: no way to pick the date
-- (runs before any fixed-clock engine run, since it uses the real clock)
-- ---------------------------------------------------------------------------

select tests.create_user('Live1');
select tests.create_user('Live2');
select tests.pair('Live1', 'Live2', 'Live pact', now());
select tests.login('Live1');
set local role authenticated;
select is((public.check_in(tests.pact('Live pact')) ->> 'local_date')::date, (now() at time zone 'UTC')::date,
          'public.check_in dates the check-in by the server clock');
reset role;

-- ---------------------------------------------------------------------------
-- day_closed
-- ---------------------------------------------------------------------------

select tests.create_user('Kai');
select tests.create_user('Lea');
select tests.pair('Kai', 'Lea', 'Too late', '2026-10-22 08:00Z');
select tests.tap('Kai', tests.pact('Too late'), '2026-10-22 09:00Z');
select public.evaluate_due_pacts('2026-10-23 00:15Z');
select tests.login('Lea');
select throws_ok(format('select private.check_in(%L, null, null, %L, %L)', tests.pact('Too late'),
                        '2026-10-22 23:59Z', '2026-10-23 00:16Z'),
                 'P0001', 'day_closed', 'check-in for a date that already has a streak_events row -> day_closed');
select is((select count(*)::int from public.check_ins where user_id = tests.uid('Lea')), 0,
          'nothing inserted for a closed day');
select is(private.check_in(tests.pact('Too late'), null, null, '2026-10-23 00:16Z', '2026-10-23 00:16Z') ->> 'local_date',
          '2026-10-23', 'checking in for the new day still works');

select * from finish();
rollback;
