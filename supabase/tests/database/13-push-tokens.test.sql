-- Phase 6: devices register their push token for whoever is signed in.
begin;
select plan(7);

select tests.create_user('Alice');
select tests.create_user('Bob');

select tests.login('Alice');
select lives_ok($$select private.register_push_token('ExponentPushToken[phone-1]', 'ios', '2026-10-22 08:00Z')$$,
                'register a device');
select lives_ok($$select private.register_push_token('ExponentPushToken[phone-1]', 'ios', '2026-10-22 09:00Z')$$,
                're-registering on every launch is harmless');
select results_eq($$select user_id, updated_at from public.push_tokens$$,
                  $$values (tests.uid('Alice'), '2026-10-22 09:00Z'::timestamptz)$$,
                  'one row, refreshed');

-- Same phone, Bob signs in (Alice never signed out).
select tests.login('Bob');
select private.register_push_token('ExponentPushToken[phone-1]', 'ios', '2026-10-22 10:00Z');
select results_eq($$select user_id from public.push_tokens$$, $$values (tests.uid('Bob'))$$,
                  'the device moves to the account now signed in, so Alice''s pushes stop going to Bob');

select throws_ok($$select private.register_push_token('not-a-token', 'ios', now())$$,
                 'P0001', 'invalid_token', 'only Expo push tokens');
select throws_ok($$select private.register_push_token('ExponentPushToken[x]', 'web', now())$$,
                 'P0001', 'invalid_platform', 'only ios and android');
select ok(has_function_privilege('authenticated', 'public.register_push_token(text, text)', 'execute')
          and not has_function_privilege('anon', 'public.register_push_token(text, text)', 'execute'),
          'signed-in users only');

select * from finish();
rollback;
