-- Pact: Phase 2 — schema and security.
--
-- Tables, RLS policies, storage buckets and policies, and the sign-up trigger.
-- Clients may read what their pacts contain but never write game state
-- directly: every streak-affecting write goes through security-definer RPCs
-- (added in Phase 3).

create extension if not exists pgcrypto;
create extension if not exists pg_cron;

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------

-- True when tz is an IANA name Postgres knows about. Offsets such as '+05:30'
-- and abbreviations such as 'EST' are rejected: local dates must follow DST.
create function public.is_valid_timezone(tz text) returns boolean
language sql stable set search_path = '' as $$
  select tz is not null and exists (select 1 from pg_catalog.pg_timezone_names where name = tz);
$$;

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

-- PROFILES (1:1 with auth.users, created by trigger on sign-up)
create table public.profiles (
  id uuid primary key references auth.users on delete cascade,
  display_name text not null check (char_length(display_name) between 1 and 40),
  avatar_path text,
  timezone text not null default 'UTC' check (public.is_valid_timezone(timezone)),
  pending_timezone text check (pending_timezone is null or public.is_valid_timezone(pending_timezone)),
  timezone_changed_at timestamptz,
  created_at timestamptz not null default now()
);

-- PUSH TOKENS (one user, many devices)
create table public.push_tokens (
  token text primary key,
  user_id uuid not null references public.profiles on delete cascade,
  platform text not null check (platform in ('ios','android')),
  updated_at timestamptz not null default now()
);

-- PACTS
create type public.pact_status as enum ('pending','active','archived');
create type public.proof_mode  as enum ('photo','tap');

create table public.pacts (
  id uuid primary key default gen_random_uuid(),
  title text not null check (char_length(title) between 1 and 40),
  proof_mode public.proof_mode not null default 'photo',
  status public.pact_status not null default 'pending',
  max_members smallint not null default 2 check (max_members between 2 and 4),
  created_by uuid not null references public.profiles,
  start_date date,                                -- first evaluated date, set on activation
  last_evaluated_date date,                       -- engine cursor
  current_streak integer not null default 0,
  longest_streak integer not null default 0,
  created_at timestamptz not null default now(),
  archived_at timestamptz
);

-- MEMBERS
create table public.pact_members (
  pact_id uuid not null references public.pacts on delete cascade,
  user_id uuid not null references public.profiles on delete cascade,
  role text not null default 'member' check (role in ('owner','member')),
  joined_at timestamptz not null default now(),
  first_required_date date not null,              -- date after joining (or activation date)
  reminders_enabled boolean not null default true,  -- 09:00 / 20:00 reminders only
  left_at timestamptz,
  primary key (pact_id, user_id)
);
create index on public.pact_members (user_id) where left_at is null;

-- INVITES
create table public.pact_invites (
  code text primary key check (code ~ '^[A-HJKMNP-Z2-9]{6}$'),
  pact_id uuid not null references public.pacts on delete cascade,
  created_by uuid not null references public.profiles,
  expires_at timestamptz not null default now() + interval '7 days',
  revoked_at timestamptz
);
create index on public.pact_invites (pact_id);

-- CHECK-INS
create table public.check_ins (
  id uuid primary key default gen_random_uuid(),
  pact_id uuid not null references public.pacts on delete cascade,
  user_id uuid not null references public.profiles on delete cascade,
  local_date date not null,                       -- computed by the server, never sent by the client
  timezone text not null,                         -- snapshot used to compute local_date
  image_path text,                                -- required when pact.proof_mode = 'photo'
  note text check (char_length(note) <= 80),
  captured_at timestamptz not null,               -- device capture time (offline grace only)
  created_at timestamptz not null default now(),
  unique (pact_id, user_id, local_date)
);

-- REACTIONS (preset set, one per member per check-in)
create table public.reactions (
  check_in_id uuid not null references public.check_ins on delete cascade,
  user_id uuid not null references public.profiles on delete cascade,
  kind text not null check (kind in ('fire','clap','flex','heart','eyes')),
  created_at timestamptz not null default now(),
  primary key (check_in_id, user_id)
);

-- STREAK EVENTS (one row per evaluated pact day; makes evaluation idempotent)
create table public.streak_events (
  pact_id uuid not null references public.pacts on delete cascade,
  local_date date not null,
  outcome text not null check (outcome in ('extended','broken','silent_miss')),
  streak_before integer not null,
  streak_after integer not null,
  missed_user_ids uuid[] not null default '{}',
  created_at timestamptz not null default now(),
  primary key (pact_id, local_date)
);

-- ENTITLEMENTS (written only by the RevenueCat webhook)
create table public.entitlements (
  user_id uuid primary key references public.profiles on delete cascade,
  is_pro boolean not null default false,
  expires_at timestamptz,
  updated_at timestamptz not null default now()
);

-- NOTIFICATION OUTBOX (written by SQL, drained by an Edge Function)
create table public.notification_outbox (
  id bigint generated always as identity primary key,
  user_id uuid not null references public.profiles on delete cascade,
  kind text not null,
  payload jsonb not null,
  dedupe_key text unique not null,                -- e.g. 'reminder_9am:<pact>:<user>:<date>'
  send_after timestamptz not null default now(),
  sent_at timestamptz,
  attempts smallint not null default 0
);
create index on public.notification_outbox (send_after) where sent_at is null;

-- ---------------------------------------------------------------------------
-- Membership helpers (security definer so policies don't recurse through RLS)
-- ---------------------------------------------------------------------------

-- Is the caller a current member of this pact?
create function public.is_member(p uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from pact_members
                 where pact_id = p and user_id = auth.uid() and left_at is null);
$$;

-- Is this user, past or present, in one of the caller's current pacts?
-- Former members stay visible so history still shows their names.
create function public.shares_pact(other uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from pact_members a join pact_members b using (pact_id)
                 where a.user_id = auth.uid() and a.left_at is null
                   and b.user_id = other);
$$;

-- Parse a path segment as a uuid without raising on garbage input, so a
-- malformed object name fails a storage policy instead of erroring.
create function public.try_uuid(t text) returns uuid
language sql immutable set search_path = '' as $$
  select case when t ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
              then t::uuid end;
$$;

-- ---------------------------------------------------------------------------
-- Row level security
-- ---------------------------------------------------------------------------

alter table public.pacts               enable row level security;
alter table public.pact_members        enable row level security;
alter table public.check_ins           enable row level security;
alter table public.reactions           enable row level security;
alter table public.streak_events       enable row level security;
alter table public.profiles            enable row level security;
alter table public.push_tokens         enable row level security;
alter table public.pact_invites        enable row level security;
alter table public.entitlements        enable row level security;
alter table public.notification_outbox enable row level security;  -- no client policies at all

create policy read_pacts     on public.pacts         for select to authenticated using (is_member(id));
create policy read_members   on public.pact_members  for select to authenticated using (is_member(pact_id));
create policy read_checkins  on public.check_ins     for select to authenticated using (is_member(pact_id));
create policy read_events    on public.streak_events for select to authenticated using (is_member(pact_id));
create policy read_invites   on public.pact_invites  for select to authenticated using (is_member(pact_id));
create policy read_reactions on public.reactions     for select to authenticated using (
  exists (select 1 from public.check_ins c where c.id = check_in_id and is_member(c.pact_id)));

create policy read_profiles on public.profiles for select to authenticated using (
  id = auth.uid() or shares_pact(id));
create policy update_own_profile on public.profiles for update to authenticated
  using (id = auth.uid()) with check (id = auth.uid());

create policy own_tokens on public.push_tokens for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

create policy read_own_entitlement on public.entitlements for select to authenticated
  using (user_id = auth.uid());

-- ---------------------------------------------------------------------------
-- Table privileges
--
-- Supabase grants everything on public tables to anon/authenticated by
-- default. RLS already blocks writes that have no policy; revoking the
-- privileges as well turns those silent no-ops into hard permission errors.
-- ---------------------------------------------------------------------------

revoke all on all tables in schema public from anon;
revoke insert, update, delete, truncate, references, trigger
  on all tables in schema public from authenticated;

grant update (display_name, avatar_path) on public.profiles to authenticated;
grant insert, update, delete on public.push_tokens to authenticated;

revoke all on public.notification_outbox from authenticated;

-- ---------------------------------------------------------------------------
-- Sign-up trigger: every auth user gets a profile
-- ---------------------------------------------------------------------------

create function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  meta jsonb := coalesce(new.raw_user_meta_data, '{}'::jsonb);
  name text;
  tz text := meta ->> 'timezone';
begin
  name := nullif(btrim(coalesce(meta ->> 'full_name', meta ->> 'name',
                                split_part(coalesce(new.email, ''), '@', 1))), '');
  insert into profiles (id, display_name, timezone)
  values (new.id,
          left(coalesce(name, 'Pact member'), 40),
          case when is_valid_timezone(tz) then tz else 'UTC' end);
  return new;
end $$;

revoke execute on function public.handle_new_user() from public, anon, authenticated;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------------------------------------------------------------------------
-- Realtime: the dashboard listens to check_ins and pacts
-- ---------------------------------------------------------------------------

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table public.check_ins, public.pacts;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Storage
--
-- proofs:  private, {pact_id}/{user_id}/{uuid}.jpg, members read, owner writes.
-- avatars: private, {user_id}/{file},              owner writes, pact-mates read.
-- ---------------------------------------------------------------------------

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('proofs',  'proofs',  false, 2097152, array['image/jpeg']),
       ('avatars', 'avatars', false, 2097152, array['image/jpeg','image/png'])
on conflict (id) do nothing;

create policy proofs_read on storage.objects for select to authenticated using (
  bucket_id = 'proofs'
  and public.is_member(public.try_uuid((storage.foldername(name))[1])));

create policy proofs_insert on storage.objects for insert to authenticated with check (
  bucket_id = 'proofs'
  and public.is_member(public.try_uuid((storage.foldername(name))[1]))
  and (storage.foldername(name))[2] = auth.uid()::text
  and array_length(storage.foldername(name), 1) = 2);

-- Needed for upsert: queue retries overwrite the same object.
create policy proofs_update on storage.objects for update to authenticated
using (
  bucket_id = 'proofs'
  and public.is_member(public.try_uuid((storage.foldername(name))[1]))
  and (storage.foldername(name))[2] = auth.uid()::text)
with check (
  bucket_id = 'proofs'
  and public.is_member(public.try_uuid((storage.foldername(name))[1]))
  and (storage.foldername(name))[2] = auth.uid()::text
  and array_length(storage.foldername(name), 1) = 2);

-- Owners may delete orphan uploads, but never a photo backing a check-in.
create policy proofs_delete on storage.objects for delete to authenticated using (
  bucket_id = 'proofs'
  and (storage.foldername(name))[2] = auth.uid()::text
  and not exists (select 1 from public.check_ins c where c.image_path = name));

create policy avatars_read on storage.objects for select to authenticated using (
  bucket_id = 'avatars'
  and ((storage.foldername(name))[1] = auth.uid()::text
       or public.shares_pact(public.try_uuid((storage.foldername(name))[1]))));

create policy avatars_insert on storage.objects for insert to authenticated with check (
  bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);

create policy avatars_update on storage.objects for update to authenticated
  using (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text)
  with check (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);

create policy avatars_delete on storage.objects for delete to authenticated using (
  bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);
