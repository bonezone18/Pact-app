import type { Today, TodayMember } from '@/lib/today';

export function member(overrides: Partial<TodayMember> & Pick<TodayMember, 'user_id' | 'display_name'>): TodayMember {
  return {
    avatar_path: null,
    is_me: false,
    role: 'member',
    required: true,
    local_date: '2026-10-22',
    day_ends_at: '2026-10-23T00:00:00.000Z',
    state: 'pending',
    check_in: null,
    ...overrides,
  };
}

export function today(overrides: Partial<Today> = {}, members?: TodayMember[]): Today {
  return {
    pact: {
      id: 'p1',
      title: 'Walk 1 mile',
      proof_mode: 'tap',
      status: 'active',
      current_streak: 3,
      longest_streak: 5,
      start_date: '2026-10-19',
      max_members: 2,
    },
    date: '2026-10-22',
    now: '2026-10-22T12:00:00.000Z',
    me: 'user-1',
    not_started: false,
    nudges_left: 2,
    members: members ?? [
      member({ user_id: 'user-1', display_name: 'Alice', is_me: true, role: 'owner' }),
      member({ user_id: 'user-2', display_name: 'Bob' }),
    ],
    ...overrides,
  };
}

export const doneCheckIn = (id: string, image_path: string | null = null) => ({
  id,
  image_path,
  note: null,
  created_at: '2026-10-22T09:00:00.000Z',
  reactions: [],
});
