// What each outbox row says on the lock screen, and where tapping it goes.
// Copy follows the spec's notification table. Pure: shared by the Edge
// Function (Deno) and the Jest tests.

export type Payload = Record<string, unknown>;
export type RenderedPush = { title: string; body: string; url: string };

const REACTION_EMOJI: Record<string, string> = {
  fire: '🔥',
  clap: '👏',
  flex: '💪',
  heart: '❤️',
  eyes: '👀',
};

const str = (v: unknown, fallback = ''): string => (typeof v === 'string' && v.trim() ? v : fallback);
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : Number(v) || 0);
const days = (n: number) => `${n} ${n === 1 ? 'day' : 'days'}`;

/** Returns null for kinds this version doesn't know (the row is skipped, not retried). */
export function renderPush(kind: string, payload: Payload): RenderedPush | null {
  const pact = str(payload.pact_id);
  const title = str(payload.title, 'Lockstep');
  const name = str(payload.name, 'Your partner');
  const home = '/';
  const checkIn = pact ? `/check-in/${pact}` : home;

  switch (kind) {
    case 'reminder_am':
      return { title, body: `Day ${num(payload.day) || 1} of ${title}. Lock it in early.`, url: checkIn };
    case 'partner_checked_in': {
      const n = num(payload.streak);
      return {
        title,
        body: n > 0
          ? `${name} just checked in. Your turn to keep ${days(n)} alive.`
          : `${name} just checked in. Your turn: today can be Day 1.`,
        url: checkIn,
      };
    }
    case 'locked':
      return { title, body: `${name} checked in. ${title} is locked for today.`, url: home };
    case 'reminder_pm':
      return { title, body: `4 hours left. ${name} is counting on you.`, url: checkIn };
    case 'reminder_late':
      return { title, body: `1 hour until your ${num(payload.streak)}-day streak resets for everyone.`, url: checkIn };
    case 'waiting':
      return { title, body: `${name} hasn't checked in yet. Send a nudge?`, url: home };
    case 'nudge':
      return { title, body: `${name} nudged you: ${title} is waiting.`, url: checkIn };
    case 'milestone':
      return { title, body: `${days(num(payload.streak))}! ${title} hit a milestone.`, url: home };
    case 'broken':
      return { title, body: `The chain broke at ${days(num(payload.streak_before))}. Day 1 starts now.`, url: home };
    case 'reaction':
      return {
        title,
        body: `${name} reacted ${REACTION_EMOJI[str(payload.kind)] ?? '👍'} to your check-in.`,
        url: home,
      };
    default:
      return null;
  }
}
