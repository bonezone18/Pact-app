import { buildMonth, shiftMonth } from '@/lib/calendar';
import {
  countdownTarget,
  formatTimeLeft,
  isLocked,
  primaryAction,
  withOptimisticCheckIn,
} from '@/lib/today';
import { doneCheckIn, member, today } from '@/test/today-fixtures';

const ME = { user_id: 'user-1', display_name: 'Alice', is_me: true };
const BOB = { user_id: 'user-2', display_name: 'Bob' };

describe('primary button', () => {
  it('"Check in" while you are pending', () => {
    expect(primaryAction(today())).toEqual({ kind: 'check_in', label: 'Check in' });
  });

  it('"Waiting on {name}" when only others are pending', () => {
    const t = today({}, [member({ ...ME, state: 'done', check_in: doneCheckIn('c1') }), member(BOB)]);
    expect(primaryAction(t)).toEqual({ kind: 'disabled', label: 'Waiting on Bob' });
  });

  it('"Locked for today" when everyone is done', () => {
    const t = today({}, [
      member({ ...ME, state: 'done', check_in: doneCheckIn('c1') }),
      member({ ...BOB, state: 'done', check_in: doneCheckIn('c2') }),
    ]);
    expect(isLocked(t)).toBe(true);
    expect(primaryAction(t).label).toBe('Locked for today');
  });

  it('a mid-day joiner does not block the lock', () => {
    const t = today({}, [
      member({ ...ME, state: 'done', check_in: doneCheckIn('c1') }),
      member({ ...BOB, state: 'done', check_in: doneCheckIn('c2') }),
      member({ user_id: 'user-3', display_name: 'Cy', required: false, state: 'not_required' }),
    ]);
    expect(isLocked(t)).toBe(true);
  });

  it('"Day 1 starts at midnight" across the date line', () => {
    expect(primaryAction(today({ not_started: true })).label).toBe('Day 1 starts at midnight');
  });

  it('a mid-day joiner is told their first day is tomorrow', () => {
    const t = today({}, [member({ ...ME, required: false, state: 'not_required' }), member(BOB)]);
    expect(primaryAction(t).label).toBe('Your first day is tomorrow');
  });

  it('a queued (unsynced) check-in counts as done straight away', () => {
    const t = withOptimisticCheckIn(today(), { fileUri: 'file:///proof.jpg', note: null });
    expect(t.members[0]).toMatchObject({ state: 'done', syncing: true, localImageUri: 'file:///proof.jpg' });
    expect(primaryAction(t).label).toBe('Waiting on Bob');
  });
});

describe('countdown', () => {
  it('shows your time left while you are pending', () => {
    const t = today({}, [member({ ...ME, day_ends_at: '2026-10-23T04:00:00Z' }), member(BOB)]);
    expect(countdownTarget(t)?.who.display_name).toBe('Alice');
    expect(countdownTarget(t)?.endsAt).toBe(Date.parse('2026-10-23T04:00:00Z'));
  });

  it("once you're done, shows the pending partner's time left", () => {
    const t = today({}, [
      member({ ...ME, state: 'done', check_in: doneCheckIn('c1'), day_ends_at: '2026-10-22T15:00:00Z' }),
      member({ ...BOB, day_ends_at: '2026-10-23T04:00:00Z' }),
    ]);
    expect(countdownTarget(t)).toMatchObject({ who: { display_name: 'Bob' }, endsAt: Date.parse('2026-10-23T04:00:00Z') });
  });

  it('nothing to count down once locked', () => {
    const t = today({}, [
      member({ ...ME, state: 'done', check_in: doneCheckIn('c1') }),
      member({ ...BOB, state: 'done', check_in: doneCheckIn('c2') }),
    ]);
    expect(countdownTarget(t)).toBeNull();
  });

  it('formats as "04h 32m left"', () => {
    expect(formatTimeLeft((4 * 60 + 32) * 60_000 + 59_000)).toBe('04h 32m left');
    expect(formatTimeLeft(5 * 60_000)).toBe('00h 05m left');
    expect(formatTimeLeft(-1000)).toBe('00h 00m left');
  });
});

describe('history calendar', () => {
  it('lays out a month Monday-first with outcomes', () => {
    const weeks = buildMonth(2026, 10, [
      { local_date: '2026-10-01', outcome: 'extended' },
      { local_date: '2026-10-02', outcome: 'broken' },
      { local_date: '2026-10-03', outcome: 'silent_miss' },
    ]);
    // Oct 1 2026 is a Thursday.
    expect(weeks[0].slice(0, 3)).toEqual([null, null, null]);
    expect(weeks[0][3]).toEqual({ date: '2026-10-01', day: 1, outcome: 'extended' });
    expect(weeks[0][4]?.outcome).toBe('missed');
    expect(weeks[0][5]?.outcome).toBe('missed');
    expect(weeks[0][6]).toEqual({ date: '2026-10-04', day: 4, outcome: null });
    expect(weeks.flat().filter(Boolean)).toHaveLength(31);
    expect(weeks.every((w) => w.length === 7)).toBe(true);
  });

  it('handles February in a leap year', () => {
    expect(buildMonth(2028, 2, []).flat().filter(Boolean)).toHaveLength(29);
  });

  it('moves between months across years', () => {
    expect(shiftMonth(2026, 1, -1)).toEqual({ year: 2025, month: 12 });
    expect(shiftMonth(2026, 12, 1)).toEqual({ year: 2027, month: 1 });
  });
});
