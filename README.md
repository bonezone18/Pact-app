# Lockstep

A habit lockbox for two people (or a small pod on Pro): commit to one daily challenge, prove it each day, share one streak.

Users see "Lockstep" and "streak". The code and database still call a shared streak a **pact** (`pacts`, `create_pact`, `/pact/[pactId]`); that word never reaches the screen.

Built server-first: Postgres functions and RLS on Supabase define the game; the Expo app is a thin client.

## Status

| Phase | Scope | State |
| --- | --- | --- |
| 1 | Project setup (Expo, EAS, Supabase CLI) | Done |
| 2 | Schema and security (tables, RLS, storage, sign-up trigger, pgTAP) | Done |
| 3 | Game RPCs, streak engine, reminders, timezone changes, pg_cron | Done |
| 4 | Apple/Google sign-in, create/invite/join, waiting room, universal links, landing page | Done |
| 5 | Dashboard, check-in (photo + tap), offline queue, reactions, nudges, history | Done |
| 6 | Push: token registration, outbox sender Edge Function (every minute), deep links | Done |
| 7–8 | Monetization, hardening | Not started |

## Layout

```
src/app/          Expo Router screens
src/lib/          Supabase client, auth, invite codes, queries
src/__tests__/    Jest unit and screen-flow tests (real routes, fake Supabase)
supabase/functions/  send-notifications Edge Function (+ _shared copy and sender logic)
landing/          Static invite landing page (lockstep.app/j/<code>) + app-link files
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

## Check-ins and the offline queue

A check-in shows as done the moment it's made. `src/lib/check-in-queue.ts` keeps it in MMKV and syncs it: upload the photo to `proofs/{pact}/{user}/{item}.jpg` (upsert), then call `check_in`. It retries on launch, on reconnect, on returning to the foreground and on a backoff that caps at 5 minutes. `already_checked_in` counts as success. A permanent refusal (`day_closed`, ...) clears the optimistic DONE, shows why and deletes the uploaded photo. `check-in-sync.ts` wires it to Supabase, the file system and the app lifecycle.

The dashboard reads `pact_today`, which works out on the server each member's state on the caller's date.

## Push notifications

SQL decides who gets what and when by writing `notification_outbox` rows. Every minute pg_cron calls the `send-notifications` Edge Function (through pg_net), which claims due rows under a 2-minute lease, sends them through Expo Push, then marks them sent or releases them for a retry (3 attempts). `DeviceNotRegistered` tokens are dropped. The copy for each kind and the screen a tap opens live in `supabase/functions/_shared/push-copy.ts`.

The app registers its token on launch if notifications are already allowed, and asks for permission after you create or join a streak.

Setup, once per Supabase project:

```bash
npx supabase functions deploy send-notifications
npx supabase secrets set CRON_SECRET=<long random string>
# optional, if "enhanced push security" is on in your Expo account:
npx supabase secrets set EXPO_ACCESS_TOKEN=<token>
```

Then in the SQL editor (the schedule reads these from Vault):

```sql
select vault.create_secret('https://<project-ref>.supabase.co', 'project_url');
select vault.create_secret('<same CRON_SECRET>', 'cron_secret');
```

Push credentials for the builds: EAS creates the iOS push key during `eas build` (or `eas credentials`). For Android, create a Firebase project for `app.lockstep`, upload its FCM V1 service-account key with `eas credentials`, and pass its `google-services.json` to builds as an EAS file variable named `GOOGLE_SERVICES_JSON`.

## Sign-in setup

- **Apple**: enable Sign in with Apple for `app.lockstep` in the Apple developer account. Supabase verifies the native ID token against the bundle ID (`supabase/config.toml`).
- **Google**: create web, iOS and Android OAuth clients. Set `EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID` / `EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID`, `GOOGLE_IOS_URL_SCHEME` (build time; `app.config.ts` only adds the Google plugin when it is set), and `SUPABASE_AUTH_EXTERNAL_GOOGLE_CLIENT_IDS` (comma-separated, web first) for Supabase.

## Invite links

`https://lockstep.app/j/<code>` opens the join screen when the app is installed (`+native-intent.tsx`); otherwise the static page in `landing/` shows the streak, copies the code and links to the stores. Before deploying it, fill in `landing/config.js`, and the team ID / signing-cert fingerprint in `landing/.well-known/`. `_redirects` (Netlify, Cloudflare Pages) and `vercel.json` carry the `/j/*` rewrite.

```bash
npm run landing:serve    # http://localhost:4173/j/K7MQ2X
```

## App and landing tests

```bash
npm test                 # Jest
npm run test:landing     # Playwright; set PLAYWRIGHT_CHROMIUM_PATH to use a pre-installed Chromium
deno check --config supabase/functions/send-notifications/deno.json supabase/functions/send-notifications/index.ts
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
