# Pact

A habit lockbox for two people (or a small pod on Pro): commit to one daily challenge, prove it each day, share one streak.

Built server-first: Postgres functions and RLS on Supabase define the game; the Expo app is a thin client.

## Status

| Phase | Scope | State |
| --- | --- | --- |
| 1 | Project setup (Expo, EAS, Supabase CLI) | Done |
| 2 | Schema and security (tables, RLS, storage, sign-up trigger, pgTAP) | Done |
| 3 | Game RPCs, streak engine, reminders, timezone changes, pg_cron | Done |
| 4–8 | Auth, daily loop, notifications, monetization, hardening | Not started |

## Layout

```
src/app/          Expo Router screens (still the create-expo-app template)
src/lib/          Supabase client
supabase/
  config.toml     Local Supabase config
  migrations/     Schema, RLS, storage policies, sign-up trigger, RPCs, engine
  tests/database/ pgTAP tests (00-helpers runs first and installs a `tests` schema)
scripts/
  test-db.sh      Runs the pgTAP suite on a throwaway Postgres (no Docker)
  supabase-shim.sql  Minimal auth/storage stand-in used by test-db.sh
```

## Setup

```bash
npm install
cp .env.example .env.local        # fill in from `npx supabase status`
npm run db:start                  # supabase start (needs Docker)
npx expo run:ios                  # or run:android; native modules need a dev build, not Expo Go
```

EAS still has to be linked to an Expo account once:

```bash
npx eas-cli login
npx eas-cli init                  # writes extra.eas.projectId into app.json
npx eas-cli update:configure      # writes updates.url
```

## Database tests

```bash
npm run db:test          # supabase test db, against the local stack
npm run db:test:local    # same suite on a throwaway Postgres; needs pgTAP, pg_cron and pg_prove
```

`db:test:local` loads `scripts/supabase-shim.sql` (API roles, `auth.users`/`auth.uid()`, `storage.objects`/`storage.foldername()`, Supabase's default grants) before the migrations, so it exercises the same policies without Docker.

## Game logic

Client RPCs (`create_pact`, `join_pact`, `regenerate_invite`, `check_in`, `react`, `nudge`, `leave_pact`, `set_reminders`, `set_timezone`, `delete_account`) are thin `public` wrappers. The logic lives in the `private` schema, where every function takes `p_now`: tests run on a fixed clock, and clients can't pick the time. Errors are raised as `P0001` with a stable code as the message (`pro_required`, `day_closed`, ...).

pg_cron runs `evaluate_due_pacts`, `enqueue_reminders` and `apply_pending_timezones` every 15 minutes.

`08-engine-concurrency` opens parallel sessions with dblink and needs `pact.test_dsn` set to a connection string for the test database (`db:test:local` sets it); elsewhere it skips.

## Checks

```bash
npm run typecheck
npm run lint
```
