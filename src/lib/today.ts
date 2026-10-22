// The dashboard's view of today: the server's answer (pact_today) with the
// caller's not-yet-synced check-in layered on top, plus the derived bits the
// screen shows (primary button, countdown).

export type MemberState = 'done' | 'pending' | 'missed' | 'not_required';
export type Reaction = { user_id: string; kind: ReactionKind };
export type ReactionKind = 'fire' | 'clap' | 'flex' | 'heart' | 'eyes';

export const REACTIONS: { kind: ReactionKind; emoji: string }[] = [
  { kind: 'fire', emoji: '🔥' },
  { kind: 'clap', emoji: '👏' },
  { kind: 'flex', emoji: '💪' },
  { kind: 'heart', emoji: '❤️' },
  { kind: 'eyes', emoji: '👀' },
];
export const reactionEmoji = (kind: string) => REACTIONS.find((r) => r.kind === kind)?.emoji ?? '';

export type TodayMember = {
  user_id: string;
  display_name: string;
  avatar_path: string | null;
  is_me: boolean;
  role: 'owner' | 'member';
  required: boolean;
  local_date: string;
  day_ends_at: string;
  state: MemberState;
  check_in: {
    id: string;
    image_path: string | null;
    note: string | null;
    created_at: string;
    reactions: Reaction[];
  } | null;
  /** Client-side only: done here, still on its way to the server. */
  syncing?: boolean;
  localImageUri?: string | null;
};

export type Today = {
  pact: {
    id: string;
    title: string;
    proof_mode: 'photo' | 'tap';
    status: 'pending' | 'active' | 'archived';
    current_streak: number;
    longest_streak: number;
    start_date: string | null;
    max_members: number;
  };
  date: string;
  now: string;
  me: string;
  not_started: boolean;
  nudges_left: number;
  members: TodayMember[];
};

export type QueuedCheckIn = { fileUri: string | null; note: string | null } | undefined;

/** Shows the caller as done while their check-in is still in the queue. */
export function withOptimisticCheckIn(today: Today, queued: QueuedCheckIn): Today {
  if (!queued) return today;
  return {
    ...today,
    members: today.members.map((m) =>
      m.is_me && m.state !== 'done'
        ? { ...m, state: 'done', syncing: true, localImageUri: queued.fileUri }
        : m,
    ),
  };
}

export const me = (today: Today) => today.members.find((m) => m.is_me);

/** Required members who still have to check in on this date. */
export function pendingOthers(today: Today): TodayMember[] {
  return today.members.filter((m) => !m.is_me && m.required && m.state === 'pending');
}

export function isLocked(today: Today): boolean {
  const required = today.members.filter((m) => m.required);
  return required.length > 0 && required.every((m) => m.state === 'done');
}

export type PrimaryAction =
  | { kind: 'check_in'; label: string }
  | { kind: 'disabled'; label: string };

export function primaryAction(today: Today): PrimaryAction {
  const self = me(today);
  if (today.not_started) return { kind: 'disabled', label: 'Day 1 starts at midnight' };
  if (!self || !self.required) return { kind: 'disabled', label: 'Your first day is tomorrow' };
  if (self.state === 'pending') return { kind: 'check_in', label: 'Check in' };
  if (isLocked(today)) return { kind: 'disabled', label: 'Locked for today' };
  const waiting = pendingOthers(today);
  if (waiting.length > 0) {
    return { kind: 'disabled', label: `Waiting on ${waiting.map((m) => m.display_name).join(' & ')}` };
  }
  return { kind: 'disabled', label: 'Day over' };
}

/**
 * Time left in *your* day; once you're done and a partner is pending,
 * theirs instead (the soonest deadline if several are).
 */
export function countdownTarget(today: Today): { who: TodayMember; endsAt: number } | null {
  const self = me(today);
  if (!self || today.not_started) return null;
  if (self.required && self.state === 'pending') return { who: self, endsAt: Date.parse(self.day_ends_at) };
  const waiting = pendingOthers(today).sort((a, b) => Date.parse(a.day_ends_at) - Date.parse(b.day_ends_at));
  return waiting[0] ? { who: waiting[0], endsAt: Date.parse(waiting[0].day_ends_at) } : null;
}

export function formatTimeLeft(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 60_000));
  const h = Math.floor(total / 60);
  const m = total % 60;
  return `${String(h).padStart(2, '0')}h ${String(m).padStart(2, '0')}m left`;
}
