# Pact

A habit lockbox for two people (or a small pod on Pro): commit to one daily challenge, prove it each day, share one streak.

Built server-first: Postgres functions and RLS on Supabase define the game; the Expo app is a thin client.

## Status

| Phase | Scope | State |
| --- | --- | --- |
| 1 | Project setup (Expo, EAS, Supabase CLI) | Done |
| 2 | Schema and security (tables, RLS, storage, sign-up trigger, pgTAP) | Done |
| 3 | Game RPCs, streak engine, reminders, timezone changes, pg_cron | Done |
| 4 | Apple/Google sign-in, create/invite/join, waiting room, universal links, landing page | Done |
| 5–8 | Daily loop, notifications, monetization, hardening | Not started |

## Layout

```
src/app/          Expo Router screens
src/lib/          Supabase client, auth, invite codes, queries
src/__tests__/    Jest unit and screen-flow tests (real routes, fake Supabase)
landing/          Static invite landing page (pactapp.io/j/<code>) + app-link files
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

## Sign-in setup

- **Apple**: enable Sign in with Apple for `io.pactapp.pact` in the Apple developer account. Supabase verifies the native ID token against the bundle ID (`supabase/config.toml`).
- **Google**: create web, iOS and Android OAuth clients. Set `EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID` / `EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID`, `GOOGLE_IOS_URL_SCHEME` (build time; `app.config.ts` only adds the Google plugin when it is set), and `SUPABASE_AUTH_EXTERNAL_GOOGLE_CLIENT_IDS` (comma-separated, web first) for Supabase.

## Invite links

`https://pactapp.io/j/<code>` opens the join screen when the app is installed (`+native-intent.tsx`); otherwise the static page in `landing/` shows the pact, copies the code and links to the stores. Before deploying it, fill in `landing/config.js`, and the team ID / signing-cert fingerprint in `landing/.well-known/`. `_redirects` (Netlify, Cloudflare Pages) and `vercel.json` carry the `/j/*` rewrite.

```bash
npm run landing:serve    # http://localhost:4173/j/K7MQ2X
```

## App and landing tests

```bash
npm test                 # Jest
npm run test:landing     # Playwright; set PLAYWRIGHT_CHROMIUM_PATH to use a pre-installed Chromium
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
