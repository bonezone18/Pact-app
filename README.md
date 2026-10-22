# Pact

A habit lockbox for two people (or a small pod on Pro): commit to one daily challenge, prove it each day, share one streak.

Built server-first: Postgres functions and RLS on Supabase define the game; the Expo app is a thin client.

## Status

| Phase | Scope | State |
| --- | --- | --- |
| 1 | Project setup (Expo, EAS, Supabase CLI) | Done |
| 2 | Schema and security (tables, RLS, storage, sign-up trigger, pgTAP) | Done |
| 3–8 | RPCs and engine, auth, daily loop, notifications, monetization, hardening | Not started |

## Layout

```
src/app/          Expo Router screens (still the create-expo-app template)
src/lib/          Supabase client
supabase/
  config.toml     Local Supabase config
  migrations/     Schema, RLS, storage policies, sign-up trigger
  tests/database/ pgTAP tests
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

## Checks

```bash
npm run typecheck
npm run lint
```
