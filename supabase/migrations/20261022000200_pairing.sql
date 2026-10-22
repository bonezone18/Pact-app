-- Pact: Phase 4 — pairing support.
--
-- invite_preview lets the landing page and the join screen show who is
-- inviting you to what, before you are a member (RLS hides pacts from
-- non-members). set_timezone now applies at once for users with nothing to
-- protect, so a brand-new account starts on its real local date.

create function private.invite_preview(p_code text, p_now timestamptz) returns jsonb
language plpgsql stable as $$
declare
  v_code text := upper(regexp_replace(coalesce(p_code, ''), '[^A-Za-z0-9]', '', 'g'));
  inv public.pact_invites%rowtype;
  pk public.pacts%rowtype;
  members integer;
  v_status text;
begin
  select * into inv from public.pact_invites where code = v_code;
  if not found or inv.revoked_at is not null then
    return jsonb_build_object('status', 'invalid', 'code', v_code);
  end if;
  select * into pk from public.pacts where id = inv.pact_id;
  if pk.status = 'archived' then
    return jsonb_build_object('status', 'invalid', 'code', v_code);
  end if;

  select count(*) into members from public.pact_members where pact_id = pk.id and left_at is null;
  v_status := case when inv.expires_at <= p_now then 'expired'
                   when members >= pk.max_members then 'full'
                   else 'valid' end;

  -- Only what the invite screen needs: no ids, no member list.
  return jsonb_build_object(
    'status', v_status,
    'code', v_code,
    'title', pk.title,
    'proof_mode', pk.proof_mode,
    'inviter_name', (select display_name from public.profiles
                      where id = coalesce(inv.created_by, pk.created_by)),
    'member_count', members,
    'max_members', pk.max_members,
    'expires_at', inv.expires_at);
end $$;

create function public.invite_preview(code text) returns jsonb
language sql stable security definer set search_path = public as $$
  select private.invite_preview(invite_preview.code, now());
$$;

revoke execute on function public.invite_preview(text) from public;
grant execute on function public.invite_preview(text) to anon, authenticated;

-- Same as Phase 3, except that a user in no active pact gets the new zone
-- immediately: there is no streak to protect, and the first launch after
-- sign-up must not leave a new user on UTC until midnight.
create or replace function private.set_timezone(p_tz text, p_now timestamptz) returns jsonb
language plpgsql as $$
declare
  uid uuid := private.require_uid();
  pr public.profiles%rowtype;
begin
  if not public.is_valid_timezone(p_tz) then
    perform private.fail('invalid_timezone');
  end if;
  select * into pr from public.profiles where id = uid for update;

  if not exists (select 1 from public.pact_members m join public.pacts p on p.id = m.pact_id
                  where m.user_id = uid and m.left_at is null and p.status = 'active') then
    update public.profiles set timezone = p_tz, pending_timezone = null where id = uid;
    return jsonb_build_object('timezone', p_tz, 'pending_timezone', null, 'applies_at', p_now);
  end if;

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
