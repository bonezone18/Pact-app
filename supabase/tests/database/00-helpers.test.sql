-- Shared helpers for the suite. Test files run alphabetically, so this one
-- runs first and commits; every other file rolls back its own data.
create extension if not exists pgtap with schema extensions;

begin;
select plan(1);

create schema if not exists tests;
grant usage on schema tests to anon, authenticated;

-- New auth user (the sign-up trigger creates the profile). Names are unique
-- within a test file and double as handles.
create or replace function tests.create_user(name text, tz text default 'UTC') returns uuid
language sql as $$
  insert into auth.users (id, email, raw_user_meta_data)
  values (gen_random_uuid(), lower(name) || '@example.com',
          jsonb_build_object('full_name', name, 'timezone', tz))
  returning id;
$$;

create or replace function tests.uid(name text) returns uuid
language sql stable as $$
  select id from public.profiles where display_name = name;
$$;

-- Act as this user for the rest of the transaction (auth.uid()).
create or replace function tests.login(name text) returns void
language sql as $$
  select set_config('request.jwt.claims',
                    jsonb_build_object('sub', tests.uid(name), 'role', 'authenticated')::text, true);
$$;

create or replace function tests.pact(title text) returns uuid
language sql stable as $$
  select id from public.pacts where pacts.title = pact.title;
$$;

-- An active pair: a creates, b joins, both at `at`.
create or replace function tests.pair(a text, b text, title text, at timestamptz,
                                      mode public.proof_mode default 'tap') returns uuid
language plpgsql as $$
declare
  r jsonb;
begin
  perform tests.login(a);
  r := private.create_pact(title, mode, 2, at);
  perform tests.login(b);
  perform private.join_pact(r ->> 'code', at);
  return (r ->> 'pact_id')::uuid;
end $$;

-- Check in as `name` at `at` (tap mode, captured on the spot).
create or replace function tests.tap(name text, pact uuid, at timestamptz) returns date
language plpgsql as $$
begin
  perform tests.login(name);
  return (private.check_in(pact, null, null, at, at) ->> 'local_date')::date;
end $$;

create or replace function tests.grant_pro(name text) returns void
language sql as $$
  insert into public.entitlements (user_id, is_pro) values (tests.uid(name), true)
  on conflict (user_id) do update set is_pro = true, expires_at = null;
$$;

select pass('test helpers installed');
select * from finish();
commit;
