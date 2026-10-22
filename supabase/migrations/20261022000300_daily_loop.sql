-- Pact: Phase 5 — the daily loop.
--
-- pact_today answers the dashboard's one question, "is today safe?", from the
-- server's clock: for the caller's current local date D, each member's state
-- on their own D (done / pending / missed / not_required), when their D ends,
-- their check-in and its reactions. Clients never work out dates themselves.

create function private.pact_today(p_pact uuid, p_now timestamptz) returns jsonb
language plpgsql stable as $$
declare
  uid uuid := private.require_uid();
  me public.pact_members;
  pk public.pacts%rowtype;
  d date;
  members jsonb;
  nudges_sent integer;
begin
  me := private.current_member(p_pact, uid);
  if me.user_id is null then
    perform private.fail('not_member');
  end if;
  select * into pk from public.pacts where id = p_pact;
  d := private.local_date(private.user_tz(uid), p_now);

  select coalesce(jsonb_agg(row order by (row ->> 'is_me')::boolean desc, row ->> 'display_name'), '[]')
    into members
    from (
      select jsonb_build_object(
               'user_id', m.user_id,
               'display_name', pr.display_name,
               'avatar_path', pr.avatar_path,
               'is_me', m.user_id = uid,
               'role', m.role,
               'required', m.first_required_date <= d,
               'local_date', private.local_date(pr.timezone, p_now),
               'day_ends_at', private.day_end(pr.timezone, d),
               'state', case
                          when c.id is not null then 'done'
                          when m.first_required_date > d then 'not_required'
                          when p_now >= private.day_end(pr.timezone, d) then 'missed'
                          else 'pending'
                        end,
               'check_in', case when c.id is null then null else jsonb_build_object(
                 'id', c.id,
                 'image_path', c.image_path,
                 'note', c.note,
                 'created_at', c.created_at,
                 'reactions', (select coalesce(jsonb_agg(jsonb_build_object('user_id', r.user_id, 'kind', r.kind)
                                                         order by r.created_at), '[]')
                                 from public.reactions r where r.check_in_id = c.id))
               end) as row
        from public.pact_members m
        join public.profiles pr on pr.id = m.user_id
        left join public.check_ins c
          on c.pact_id = m.pact_id and c.user_id = m.user_id and c.local_date = d
       where m.pact_id = p_pact and m.left_at is null
    ) s;

  select count(*) into nudges_sent
    from public.notification_outbox
   where kind = 'nudge'
     and payload ->> 'pact_id' = p_pact::text
     and payload ->> 'from' = uid::text
     and payload ->> 'sender_date' = d::text;

  return jsonb_build_object(
    'pact', jsonb_build_object(
      'id', pk.id, 'title', pk.title, 'proof_mode', pk.proof_mode, 'status', pk.status,
      'current_streak', pk.current_streak, 'longest_streak', pk.longest_streak,
      'start_date', pk.start_date, 'max_members', pk.max_members),
    'date', d,
    'now', p_now,
    'me', uid,
    'not_started', d < me.first_required_date,
    'nudges_left', greatest(0, 2 - nudges_sent),
    'members', members);
end $$;

create function public.pact_today(pact_id uuid) returns jsonb
language sql stable security definer set search_path = public as $$
  select private.pact_today(pact_today.pact_id, now());
$$;

revoke execute on function public.pact_today(uuid) from public, anon;
grant execute on function public.pact_today(uuid) to authenticated;

-- Reactions show up live on the dashboard alongside check-ins.
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table public.reactions;
  end if;
end $$;
