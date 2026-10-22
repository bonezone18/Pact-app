-- Pact: Phase 3 — game RPCs and the streak engine.
--
-- Every function that depends on the clock takes `p_now`. The real logic lives
-- in the `private` schema, which the Data API doesn't expose and clients can't
-- execute; the public RPCs are thin wrappers that pass `now()`. Tests call the
-- private functions with a fixed clock. Clients can never choose the time.
--
-- Errors are raised as SQLSTATE P0001 with a stable code as the message
-- (`pro_required`, `day_closed`, ...), which supabase-js surfaces as
-- `error.message`.

create schema if not exists private;
revoke all on schema private from public;
alter default privileges in schema private revoke execute on functions from public;

-- Deleting an account must not be blocked by pacts or invites it created.
alter table public.pacts alter column created_by drop not null;
alter table public.pacts drop constraint pacts_created_by_fkey,
  add constraint pacts_created_by_fkey foreign key (created_by)
    references public.profiles on delete set null;
alter table public.pact_invites drop constraint pact_invites_created_by_fkey,
  add constraint pact_invites_created_by_fkey foreign key (created_by)
    references public.profiles on delete cascade;

-- Supports the nudge rate limit lookup.
create index on public.notification_outbox (user_id, kind);

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------

create function private.fail(code text) returns void
language plpgsql as $$
begin
  raise exception using errcode = 'P0001', message = code;
end $$;

create function private.require_uid() returns uuid
language plpgsql stable as $$
declare
  uid uuid := auth.uid();
begin
  if uid is null then
    perform private.fail('not_authenticated');
  end if;
  return uid;
end $$;

-- A member's calendar date at an instant, in their IANA timezone.
create function private.local_date(tz text, at timestamptz) returns date
language sql stable as $$
  select (at at time zone tz)::date;
$$;

-- A member's local midnight ending date d, as an absolute instant.
create function private.day_end(tz text, d date) returns timestamptz
language sql stable as $$
  select (d + 1)::timestamp at time zone tz;
$$;

-- Pushes due between 22:00 and 08:00 local wait until 08:00 local.
create function private.outside_quiet_hours(tz text, at timestamptz) returns timestamptz
language sql stable as $$
  select case
    when (at at time zone tz)::time >= time '22:00'
      then (((at at time zone tz)::date + 1) + time '08:00') at time zone tz
    when (at at time zone tz)::time < time '08:00'
      then ((at at time zone tz)::date + time '08:00') at time zone tz
    else at
  end;
$$;

create function private.user_tz(uid uuid) returns text
language sql stable as $$
  select timezone from public.profiles where id = uid;
$$;

create function private.is_pro(uid uuid, p_now timestamptz) returns boolean
language sql stable as $$
  select coalesce((select is_pro and (expires_at is null or expires_at > p_now)
                     from public.entitlements where user_id = uid), false);
$$;

-- Pending or active pacts the user currently belongs to (the free limit is 1).
create function private.open_pact_count(uid uuid) returns integer
language sql stable as $$
  select count(*)::int
    from public.pact_members m join public.pacts p on p.id = m.pact_id
   where m.user_id = uid and m.left_at is null and p.status in ('pending','active');
$$;

-- Serializes one user's create/join calls so parallel requests can't both
-- slip under the free limit.
create function private.lock_user_limits(uid uuid) returns void
language sql as $$
  select pg_advisory_xact_lock(hashtextextended('pact-limit:' || uid, 0));
$$;

create function private.current_member(p_pact uuid, uid uuid) returns public.pact_members
language sql stable as $$
  select * from public.pact_members
   where pact_id = p_pact and user_id = uid and left_at is null;
$$;

-- 6 characters from the unambiguous alphabet (no 0/O, 1/I/L).
create function private.new_invite_code() returns text
language sql volatile as $$
  select string_agg(substr('ABCDEFGHJKMNPQRSTUVWXYZ23456789', get_byte(b, i) % 31 + 1, 1), '' order by i)
    from (select uuid_send(gen_random_uuid()) as b) r, generate_series(0, 5) i;
$$;

create function private.issue_invite(p_pact uuid, p_by uuid, p_now timestamptz) returns text
language plpgsql as $$
declare
  c text;
begin
  loop
    c := private.new_invite_code();
    insert into public.pact_invites (code, pact_id, created_by, expires_at)
    values (c, p_pact, p_by, p_now + interval '7 days')
    on conflict (code) do nothing;
    exit when found;
  end loop;
  return c;
end $$;

create function private.enqueue(p_user uuid, p_kind text, p_payload jsonb, p_key text,
                                p_send_after timestamptz) returns void
language sql as $$
  insert into public.notification_outbox (user_id, kind, payload, dedupe_key, send_after)
  values (p_user, p_kind, p_payload, p_key, p_send_after)
  on conflict (dedupe_key) do nothing;
$$;

-- ---------------------------------------------------------------------------
-- Pacts, invites, membership
-- ---------------------------------------------------------------------------

create function private.create_pact(p_title text, p_proof_mode public.proof_mode,
                                    p_max_members integer, p_now timestamptz) returns jsonb
language plpgsql as $$
declare
  uid uuid := private.require_uid();
  t text := btrim(p_title);
  pid uuid;
  c text;
begin
  if t is null or char_length(t) not between 1 and 40 then
    perform private.fail('invalid_title');
  end if;
  if p_max_members is null or p_max_members not between 2 and 4 then
    perform private.fail('invalid_pod_size');
  end if;

  perform private.lock_user_limits(uid);
  if not private.is_pro(uid, p_now)
     and (p_max_members > 2 or private.open_pact_count(uid) >= 1) then
    perform private.fail('pro_required');
  end if;

  insert into public.pacts (title, proof_mode, max_members, created_by, created_at)
  values (t, coalesce(p_proof_mode, 'photo'), p_max_members, uid, p_now)
  returning id into pid;

  -- first_required_date is a placeholder until the pact activates.
  insert into public.pact_members (pact_id, user_id, role, joined_at, first_required_date)
  values (pid, uid, 'owner', p_now, private.local_date(private.user_tz(uid), p_now));

  c := private.issue_invite(pid, uid, p_now);
  return jsonb_build_object('pact_id', pid, 'code', c, 'expires_at', p_now + interval '7 days');
end $$;

create function private.join_pact(p_code text, p_now timestamptz) returns jsonb
language plpgsql as $$
declare
  uid uuid := private.require_uid();
  v_code text := upper(regexp_replace(coalesce(p_code, ''), '[^A-Za-z0-9]', '', 'g'));
  inv public.pact_invites%rowtype;
  pk public.pacts%rowtype;
  members integer;
  required date;
  v_start date;
begin
  select * into inv from public.pact_invites where code = v_code;
  if not found or inv.revoked_at is not null then
    perform private.fail('invalid_code');
  end if;

  -- Lock the pact so concurrent joiners can't overfill it.
  select * into pk from public.pacts where id = inv.pact_id for update;
  if pk.status = 'archived' then
    perform private.fail('invalid_code');
  end if;
  if inv.expires_at <= p_now then
    perform private.fail('expired_code');
  end if;
  if (private.current_member(pk.id, uid)).user_id is not null then
    perform private.fail('already_member');
  end if;

  select count(*) into members from public.pact_members where pact_id = pk.id and left_at is null;
  if members >= pk.max_members then
    perform private.fail('pact_full');
  end if;

  perform private.lock_user_limits(uid);
  if not private.is_pro(uid, p_now) and private.open_pact_count(uid) >= 1 then
    perform private.fail('pro_required');
  end if;

  if pk.status = 'active' then
    -- Joining a running pod: first required the day after joining.
    required := greatest(private.local_date(private.user_tz(uid), p_now) + 1, pk.start_date);
  else
    required := private.local_date(private.user_tz(uid), p_now);  -- replaced on activation
  end if;

  insert into public.pact_members (pact_id, user_id, role, joined_at, first_required_date)
  values (pk.id, uid, 'member', p_now, required)
  on conflict (pact_id, user_id) do update
    set left_at = null, role = 'member', joined_at = excluded.joined_at,
        first_required_date = excluded.first_required_date;

  if pk.status = 'pending' and members + 1 >= 2 then
    -- Day 1 is the later of the founders' local dates, so nobody across the
    -- date line is required before their own calendar reaches it.
    select max(private.local_date(pr.timezone, p_now)) into v_start
      from public.pact_members m join public.profiles pr on pr.id = m.user_id
     where m.pact_id = pk.id and m.left_at is null;

    update public.pact_members set first_required_date = v_start
     where pact_id = pk.id and left_at is null;
    update public.pacts set status = 'active', start_date = v_start where id = pk.id;
    pk.status := 'active';
  end if;

  return jsonb_build_object('pact_id', pk.id, 'status', pk.status);
end $$;

create function private.regenerate_invite(p_pact uuid, p_now timestamptz) returns jsonb
language plpgsql as $$
declare
  uid uuid := private.require_uid();
  c text;
begin
  if (private.current_member(p_pact, uid)).user_id is null then
    perform private.fail('not_member');
  end if;
  if (select status from public.pacts where id = p_pact) = 'archived' then
    perform private.fail('pact_inactive');
  end if;

  update public.pact_invites set revoked_at = p_now
   where pact_id = p_pact and revoked_at is null;
  c := private.issue_invite(p_pact, uid, p_now);
  return jsonb_build_object('code', c, 'expires_at', p_now + interval '7 days');
end $$;

create function private.leave_pact(p_pact uuid, p_now timestamptz) returns jsonb
language plpgsql as $$
declare
  uid uuid := private.require_uid();
  pk public.pacts%rowtype;
  remaining integer;
begin
  select * into pk from public.pacts where id = p_pact for update;
  if (private.current_member(p_pact, uid)).user_id is null then
    perform private.fail('not_member');
  end if;

  update public.pact_members set left_at = p_now where pact_id = p_pact and user_id = uid;
  select count(*) into remaining from public.pact_members where pact_id = p_pact and left_at is null;

  -- A pair (or a pending pact) can't continue alone; a pod of 2+ carries on.
  if pk.status <> 'archived' and (pk.status = 'pending' or remaining < 2) then
    update public.pacts set status = 'archived', archived_at = p_now where id = p_pact;
    update public.pact_invites set revoked_at = p_now where pact_id = p_pact and revoked_at is null;
    pk.status := 'archived';
  end if;

  return jsonb_build_object('pact_id', p_pact, 'status', pk.status);
end $$;

create function private.set_reminders(p_pact uuid, p_enabled boolean) returns void
language plpgsql as $$
declare
  uid uuid := private.require_uid();
begin
  update public.pact_members set reminders_enabled = coalesce(p_enabled, true)
   where pact_id = p_pact and user_id = uid and left_at is null;
  if not found then
    perform private.fail('not_member');
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Check-ins, reactions, nudges
-- ---------------------------------------------------------------------------

create function private.check_in(p_pact uuid, p_image_path text, p_note text,
                                 p_captured_at timestamptz, p_now timestamptz) returns jsonb
language plpgsql as $$
declare
  uid uuid := private.require_uid();
  m public.pact_members;
  pk public.pacts%rowtype;
  me public.profiles%rowtype;
  d date;
  v_note text := nullif(btrim(p_note), '');
  v_image text := p_image_path;
  cid uuid;
  r record;
  pending integer;
  payload jsonb;
begin
  m := private.current_member(p_pact, uid);
  if m.user_id is null then
    perform private.fail('not_member');
  end if;
  select * into pk from public.pacts where id = p_pact;
  if pk.status <> 'active' then
    perform private.fail('pact_inactive');
  end if;
  select * into me from public.profiles where id = uid;

  -- The server's clock decides the date. The device's capture time only
  -- matters inside a 20-minute window just after the member's midnight.
  d := private.local_date(me.timezone, p_now);
  if p_captured_at <= p_now and p_captured_at >= p_now - interval '20 minutes'
     and private.local_date(me.timezone, p_captured_at) < d then
    d := private.local_date(me.timezone, p_captured_at);
  end if;

  if d < m.first_required_date then
    perform private.fail('not_started');
  end if;
  if exists (select 1 from public.streak_events where pact_id = p_pact and local_date = d) then
    perform private.fail('day_closed');
  end if;

  if pk.proof_mode = 'photo' then
    if v_image is null or btrim(v_image) = '' then
      perform private.fail('photo_required');
    end if;
    if v_image !~ ('^' || p_pact || '/' || uid || '/[^/]+$')
       or not exists (select 1 from storage.objects where bucket_id = 'proofs' and name = v_image) then
      perform private.fail('invalid_image_path');
    end if;
  else
    v_image := null;
  end if;

  if char_length(v_note) > 80 then
    perform private.fail('note_too_long');
  end if;

  insert into public.check_ins (pact_id, user_id, local_date, timezone, image_path, note, captured_at, created_at)
  values (p_pact, uid, d, me.timezone, v_image, v_note, coalesce(least(p_captured_at, p_now), p_now), p_now)
  on conflict (pact_id, user_id, local_date) do nothing
  returning id into cid;
  if cid is null then
    perform private.fail('already_checked_in');
  end if;

  payload := jsonb_build_object('pact_id', p_pact, 'title', pk.title, 'name', me.display_name,
                                'streak', pk.current_streak, 'date', d, 'check_in_id', cid);

  -- "Your turn" to required members still pending on this same date.
  for r in
    select m2.user_id, pr.timezone
      from public.pact_members m2 join public.profiles pr on pr.id = m2.user_id
     where m2.pact_id = p_pact and m2.left_at is null and m2.first_required_date <= d
       and m2.user_id <> uid
       and not exists (select 1 from public.check_ins c
                        where c.pact_id = p_pact and c.user_id = m2.user_id and c.local_date = d)
  loop
    if private.local_date(r.timezone, p_now) = d then
      perform private.enqueue(r.user_id, 'partner_checked_in', payload,
                              'in:' || cid || ':' || r.user_id, p_now);
    end if;
  end loop;

  -- Last one in: tell everyone else the day is locked.
  select count(*) into pending
    from public.pact_members m2
   where m2.pact_id = p_pact and m2.left_at is null and m2.first_required_date <= d
     and not exists (select 1 from public.check_ins c
                      where c.pact_id = p_pact and c.user_id = m2.user_id and c.local_date = d);
  if pending = 0 then
    perform private.enqueue(m2.user_id, 'locked', payload,
                            'lock:' || p_pact || ':' || d || ':' || m2.user_id, p_now)
       from public.pact_members m2
      where m2.pact_id = p_pact and m2.left_at is null and m2.first_required_date <= d
        and m2.user_id <> uid;
  end if;

  return jsonb_build_object('check_in_id', cid, 'local_date', d);
end $$;

create function private.react(p_check_in uuid, p_kind text, p_now timestamptz) returns void
language plpgsql as $$
declare
  uid uuid := private.require_uid();
  ci public.check_ins%rowtype;
begin
  select * into ci from public.check_ins where id = p_check_in;
  if not found or (private.current_member(ci.pact_id, uid)).user_id is null then
    perform private.fail('not_member');
  end if;
  if ci.user_id = uid then
    perform private.fail('own_check_in');
  end if;
  if p_kind is null or p_kind not in ('fire','clap','flex','heart','eyes') then
    perform private.fail('invalid_kind');
  end if;

  insert into public.reactions (check_in_id, user_id, kind, created_at)
  values (p_check_in, uid, p_kind, p_now)
  on conflict (check_in_id, user_id) do update set kind = excluded.kind, created_at = excluded.created_at;

  -- One push per check-in per reactor, however often they change the emoji.
  perform private.enqueue(ci.user_id, 'reaction',
    jsonb_build_object('pact_id', ci.pact_id, 'check_in_id', ci.id, 'kind', p_kind,
                       'name', (select display_name from public.profiles where id = uid)),
    'react:' || ci.id || ':' || uid, p_now);
end $$;

create function private.nudge(p_pact uuid, p_user uuid, p_now timestamptz) returns void
language plpgsql as $$
declare
  uid uuid := private.require_uid();
  target public.pact_members;
  pk public.pacts%rowtype;
  target_date date;
  sender_date date;
  sent integer;
begin
  target := private.current_member(p_pact, p_user);
  if (private.current_member(p_pact, uid)).user_id is null
     or target.user_id is null or p_user = uid then
    perform private.fail('not_member');
  end if;
  select * into pk from public.pacts where id = p_pact;
  if pk.status <> 'active' then
    perform private.fail('pact_inactive');
  end if;

  target_date := private.local_date(private.user_tz(p_user), p_now);
  if target_date < target.first_required_date then
    perform private.fail('not_started');
  end if;
  if exists (select 1 from public.check_ins
              where pact_id = p_pact and user_id = p_user and local_date = target_date) then
    perform private.fail('already_checked_in');
  end if;

  -- 2 nudges per sender per pact per sender-local day. Outbox rows are the
  -- record, so the sender must never delete nudge rows.
  sender_date := private.local_date(private.user_tz(uid), p_now);
  perform pg_advisory_xact_lock(hashtextextended('nudge:' || p_pact || ':' || uid, 0));
  select count(*) into sent
    from public.notification_outbox
   where kind = 'nudge'
     and payload ->> 'pact_id' = p_pact::text
     and payload ->> 'from' = uid::text
     and payload ->> 'sender_date' = sender_date::text;
  if sent >= 2 then
    perform private.fail('rate_limited');
  end if;

  perform private.enqueue(p_user, 'nudge',
    jsonb_build_object('pact_id', p_pact, 'title', pk.title, 'from', uid, 'sender_date', sender_date,
                       'name', (select display_name from public.profiles where id = uid)),
    'nudge:' || p_pact || ':' || uid || ':' || p_user || ':' || sender_date || ':' || (sent + 1),
    p_now);
end $$;

-- ---------------------------------------------------------------------------
-- Account
-- ---------------------------------------------------------------------------

-- The new zone waits in pending_timezone until the next local midnight in the
-- old zone (see apply_pending_timezones). One change per 24 h stops
-- date-hopping. Moving back to the current zone just cancels the pending one.
create function private.set_timezone(p_tz text, p_now timestamptz) returns jsonb
language plpgsql as $$
declare
  uid uuid := private.require_uid();
  pr public.profiles%rowtype;
begin
  if not public.is_valid_timezone(p_tz) then
    perform private.fail('invalid_timezone');
  end if;
  select * into pr from public.profiles where id = uid for update;

  if p_tz = pr.timezone then
    update public.profiles set pending_timezone = null where id = uid;
    return jsonb_build_object('timezone', pr.timezone, 'pending_timezone', null);
  end if;
  if p_tz is distinct from pr.pending_timezone then
    if pr.timezone_changed_at > p_now - interval '24 hours' then
      perform private.fail('rate_limited');
    end if;
    update public.profiles set pending_timezone = p_tz, timezone_changed_at = p_now where id = uid;
    pr.timezone_changed_at := p_now;
  end if;

  return jsonb_build_object(
    'timezone', pr.timezone, 'pending_timezone', p_tz,
    'applies_at', private.day_end(pr.timezone, private.local_date(pr.timezone, pr.timezone_changed_at)));
end $$;

create function private.delete_account(p_now timestamptz) returns void
language plpgsql as $$
declare
  uid uuid := private.require_uid();
  pid uuid;
begin
  for pid in select pact_id from public.pact_members where user_id = uid and left_at is null loop
    perform private.leave_pact(pid, p_now);
  end loop;
  delete from auth.users where id = uid;  -- cascades to the profile and its rows
end $$;

-- ---------------------------------------------------------------------------
-- Scheduled jobs (pg_cron). Not callable by clients.
-- ---------------------------------------------------------------------------

create function public.enqueue_day_result(p_pact uuid, p_date date, p_outcome text,
                                          p_streak_before integer, p_streak_after integer,
                                          p_missed uuid[], p_now timestamptz default now())
returns void
language plpgsql security definer set search_path = public as $$
declare
  title text := (select p.title from pacts p where p.id = p_pact);
  payload jsonb := jsonb_build_object('pact_id', p_pact, 'title', title, 'date', p_date,
                                      'streak_before', p_streak_before, 'streak', p_streak_after,
                                      'missed_user_ids', to_jsonb(p_missed));
begin
  if p_outcome = 'extended' and p_streak_after in (7, 30, 50, 100, 365) then
    perform private.enqueue(m.user_id, 'milestone', payload,
                            'ms:' || p_pact || ':' || p_date || ':' || m.user_id, p_now)
       from pact_members m
      where m.pact_id = p_pact and m.left_at is null;
  elsif p_outcome = 'broken' then
    perform private.enqueue(m.user_id, 'broken', payload,
                            'br:' || p_pact || ':' || p_date || ':' || m.user_id,
                            private.outside_quiet_hours(pr.timezone, p_now))
       from pact_members m join profiles pr on pr.id = m.user_id
      where m.pact_id = p_pact and m.left_at is null;
  end if;
  -- silent_miss: recorded, never pushed.
end $$;

-- Evaluates every closed, unevaluated pact day, in order. Each day writes one
-- streak_events row; its primary key makes a re-run fail safely, and the
-- row lock + SKIP LOCKED keeps concurrent runs off the same pact.
create function public.evaluate_due_pacts(p_now timestamptz default now()) returns integer
language plpgsql security definer set search_path = public as $$
declare
  p pacts%rowtype;
  cur pacts%rowtype;
  d date;
  close_at timestamptz;
  missed uuid[];
  v_outcome text;
  new_streak integer;
  evaluated integer := 0;
begin
  for p in select * from pacts where status = 'active' order by id for update skip locked loop
    cur := p;
    begin
      loop  -- catch-up loop: evaluates every closed day, in order
        d := coalesce(cur.last_evaluated_date + 1, cur.start_date);

        select max(private.day_end(pr.timezone, d)) + interval '15 minutes'
          into close_at
          from pact_members m join profiles pr on pr.id = m.user_id
         where m.pact_id = cur.id and m.left_at is null and m.first_required_date <= d;

        exit when close_at is null or close_at > p_now;

        select coalesce(array_agg(m.user_id order by m.user_id), '{}') into missed
          from pact_members m
         where m.pact_id = cur.id and m.left_at is null and m.first_required_date <= d
           and not exists (select 1 from check_ins c
                            where c.pact_id = cur.id and c.user_id = m.user_id and c.local_date = d);

        if cardinality(missed) = 0 then
          v_outcome := 'extended';    new_streak := cur.current_streak + 1;
        elsif cur.current_streak = 0 then
          v_outcome := 'silent_miss'; new_streak := 0;
        else
          v_outcome := 'broken';      new_streak := 0;
        end if;

        insert into streak_events (pact_id, local_date, outcome, streak_before, streak_after,
                                   missed_user_ids, created_at)
        values (cur.id, d, v_outcome, cur.current_streak, new_streak, missed, p_now);

        perform enqueue_day_result(cur.id, d, v_outcome, cur.current_streak, new_streak, missed, p_now);

        update pacts set current_streak = new_streak,
                         longest_streak = greatest(longest_streak, new_streak),
                         last_evaluated_date = d
         where id = cur.id
        returning * into cur;

        evaluated := evaluated + 1;
      end loop;
    exception when unique_violation then
      -- Another run already evaluated this day; its result stands. Only this
      -- pact's work is rolled back, the rest of the batch continues.
      null;
    end;
  end loop;
  return evaluated;
end $$;

-- Scheduled reminders, in each recipient's local time. The first run at or
-- after the target time inserts the row; dedupe keys stop repeats. Each
-- reminder only fires inside its own window so a late run never sends a
-- stale "good morning".
create function public.enqueue_reminders(p_now timestamptz default now()) returns integer
language plpgsql security definer set search_path = public as $$
declare
  r record;
  base jsonb;
  waiting_on text;
  n_before integer := (select count(*) from notification_outbox);
begin
  for r in
    select m.pact_id, m.user_id, m.reminders_enabled, p.title, p.current_streak, pr.timezone,
           private.local_date(pr.timezone, p_now) as d,
           (p_now at time zone pr.timezone)::time as t,
           m.first_required_date
      from pact_members m
      join pacts p on p.id = m.pact_id and p.status = 'active'
      join profiles pr on pr.id = m.user_id
     where m.left_at is null
  loop
    continue when r.d < r.first_required_date or r.t < time '09:00';

    base := jsonb_build_object('pact_id', r.pact_id, 'title', r.title, 'date', r.d,
                               'streak', r.current_streak);

    if not exists (select 1 from check_ins c
                    where c.pact_id = r.pact_id and c.user_id = r.user_id and c.local_date = r.d) then
      if r.reminders_enabled and r.t < time '20:00' then
        perform private.enqueue(r.user_id, 'reminder_am', base || jsonb_build_object('day', r.current_streak + 1),
                                'am:' || r.pact_id || ':' || r.user_id || ':' || r.d, p_now);
      elsif r.reminders_enabled and r.t >= time '20:00' and r.t < time '23:00' then
        perform private.enqueue(r.user_id, 'reminder_pm',
          base || jsonb_build_object('name', (
            select string_agg(pr2.display_name, ', ' order by pr2.display_name)
              from pact_members m2 join profiles pr2 on pr2.id = m2.user_id
             where m2.pact_id = r.pact_id and m2.left_at is null and m2.user_id <> r.user_id)),
          'pm:' || r.pact_id || ':' || r.user_id || ':' || r.d, p_now);
      elsif r.t >= time '23:00' and r.current_streak >= 1 then
        perform private.enqueue(r.user_id, 'reminder_late', base,
                                'late:' || r.pact_id || ':' || r.user_id || ':' || r.d, p_now);
      end if;
    elsif r.t >= time '23:00' and r.current_streak >= 1 then
      -- Partners still pending on the same date, who can still save it.
      select string_agg(pr2.display_name, ', ' order by pr2.display_name) into waiting_on
        from pact_members m2 join profiles pr2 on pr2.id = m2.user_id
       where m2.pact_id = r.pact_id and m2.left_at is null and m2.user_id <> r.user_id
         and m2.first_required_date <= r.d
         and private.local_date(pr2.timezone, p_now) = r.d
         and not exists (select 1 from check_ins c
                          where c.pact_id = r.pact_id and c.user_id = m2.user_id and c.local_date = r.d);
      if waiting_on is not null then
        perform private.enqueue(r.user_id, 'waiting', base || jsonb_build_object('name', waiting_on),
                                'wait:' || r.pact_id || ':' || r.user_id || ':' || r.d, p_now);
      end if;
    end if;
  end loop;
  return (select count(*) from notification_outbox) - n_before;
end $$;

-- Swaps in pending timezones once the old zone's local midnight has passed.
create function public.apply_pending_timezones(p_now timestamptz default now()) returns integer
language plpgsql security definer set search_path = public as $$
declare
  n integer;
begin
  update profiles
     set timezone = pending_timezone, pending_timezone = null
   where pending_timezone is not null
     and p_now >= private.day_end(timezone, private.local_date(timezone, timezone_changed_at));
  get diagnostics n = row_count;
  return n;
end $$;

revoke execute on function public.enqueue_day_result(uuid, date, text, integer, integer, uuid[], timestamptz),
                           public.evaluate_due_pacts(timestamptz),
                           public.enqueue_reminders(timestamptz),
                           public.apply_pending_timezones(timestamptz)
  from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Client RPCs: thin wrappers that pin the clock to now()
-- ---------------------------------------------------------------------------

create function public.create_pact(title text, proof_mode public.proof_mode default 'photo',
                                   max_members integer default 2) returns jsonb
language sql security definer set search_path = public as $$
  select private.create_pact(create_pact.title, create_pact.proof_mode, create_pact.max_members, now());
$$;

create function public.join_pact(code text) returns jsonb
language sql security definer set search_path = public as $$
  select private.join_pact(join_pact.code, now());
$$;

create function public.regenerate_invite(pact_id uuid) returns jsonb
language sql security definer set search_path = public as $$
  select private.regenerate_invite(regenerate_invite.pact_id, now());
$$;

create function public.check_in(pact_id uuid, image_path text default null, note text default null,
                                captured_at timestamptz default null) returns jsonb
language sql security definer set search_path = public as $$
  select private.check_in(check_in.pact_id, check_in.image_path, check_in.note, check_in.captured_at, now());
$$;

create function public.react(check_in_id uuid, kind text) returns void
language sql security definer set search_path = public as $$
  select private.react(react.check_in_id, react.kind, now());
$$;

create function public.nudge(pact_id uuid, user_id uuid) returns void
language sql security definer set search_path = public as $$
  select private.nudge(nudge.pact_id, nudge.user_id, now());
$$;

create function public.leave_pact(pact_id uuid) returns jsonb
language sql security definer set search_path = public as $$
  select private.leave_pact(leave_pact.pact_id, now());
$$;

create function public.set_reminders(pact_id uuid, enabled boolean) returns void
language sql security definer set search_path = public as $$
  select private.set_reminders(set_reminders.pact_id, set_reminders.enabled);
$$;

create function public.set_timezone(tz text) returns jsonb
language sql security definer set search_path = public as $$
  select private.set_timezone(set_timezone.tz, now());
$$;

create function public.delete_account() returns void
language sql security definer set search_path = public as $$
  select private.delete_account(now());
$$;

revoke execute on function public.create_pact(text, public.proof_mode, integer),
                           public.join_pact(text),
                           public.regenerate_invite(uuid),
                           public.check_in(uuid, text, text, timestamptz),
                           public.react(uuid, text),
                           public.nudge(uuid, uuid),
                           public.leave_pact(uuid),
                           public.set_reminders(uuid, boolean),
                           public.set_timezone(text),
                           public.delete_account()
  from public, anon;
grant execute on function public.create_pact(text, public.proof_mode, integer),
                          public.join_pact(text),
                          public.regenerate_invite(uuid),
                          public.check_in(uuid, text, text, timestamptz),
                          public.react(uuid, text),
                          public.nudge(uuid, uuid),
                          public.leave_pact(uuid),
                          public.set_reminders(uuid, boolean),
                          public.set_timezone(text),
                          public.delete_account()
  to authenticated;

-- ---------------------------------------------------------------------------
-- Schedules (every 15 minutes covers :30 and :45 timezone offsets)
-- ---------------------------------------------------------------------------

do $$
begin
  perform cron.schedule('apply-pending-timezones', '*/15 * * * *', 'select public.apply_pending_timezones()');
  perform cron.schedule('evaluate-pacts',          '*/15 * * * *', 'select public.evaluate_due_pacts()');
  perform cron.schedule('enqueue-reminders',       '*/15 * * * *', 'select public.enqueue_reminders()');
end $$;
