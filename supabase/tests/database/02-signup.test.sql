-- The sign-up trigger creates exactly one profile per auth user.
begin;
create extension if not exists pgtap with schema extensions;
select plan(8);

insert into auth.users (id, email, raw_user_meta_data) values
  ('aaaaaaaa-0000-4000-8000-000000000001', 'alice@example.com',
   '{"full_name": "Alice Example", "timezone": "Asia/Tokyo"}'),
  ('aaaaaaaa-0000-4000-8000-000000000002', 'bob.smith@example.com', null),
  ('aaaaaaaa-0000-4000-8000-000000000003', null, '{"name": "Carol", "timezone": "Not/AZone"}'),
  ('aaaaaaaa-0000-4000-8000-000000000004', null, jsonb_build_object('full_name', repeat('z', 60))),
  ('aaaaaaaa-0000-4000-8000-000000000005', null, '{"full_name": "   "}');

select is((select count(*)::int from public.profiles), 5, 'one profile per new auth user');

select results_eq(
  $$select display_name, timezone from public.profiles
     where id = 'aaaaaaaa-0000-4000-8000-000000000001'$$,
  $$values ('Alice Example'::text, 'Asia/Tokyo'::text)$$,
  'name and timezone prefilled from provider metadata');

select is(
  (select display_name from public.profiles where id = 'aaaaaaaa-0000-4000-8000-000000000002'),
  'bob.smith', 'falls back to the email local part');

select is(
  (select timezone from public.profiles where id = 'aaaaaaaa-0000-4000-8000-000000000003'),
  'UTC', 'invalid timezone metadata falls back to UTC');

select is(
  (select char_length(display_name) from public.profiles where id = 'aaaaaaaa-0000-4000-8000-000000000004'),
  40, 'long provider names are truncated to 40 chars');

select is(
  (select display_name from public.profiles where id = 'aaaaaaaa-0000-4000-8000-000000000005'),
  'Pact member', 'blank names get a placeholder');

delete from auth.users where id = 'aaaaaaaa-0000-4000-8000-000000000001';
select is(
  (select count(*)::int from public.profiles where id = 'aaaaaaaa-0000-4000-8000-000000000001'),
  0, 'deleting the auth user cascades to the profile');

-- Clients cannot call the trigger function directly.
set local role authenticated;
select throws_ok('select public.handle_new_user()', '42501', null,
                 'handle_new_user is not executable by clients');
reset role;

select * from finish();
rollback;
