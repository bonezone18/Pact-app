import type { StreakEvent } from '@/lib/queries';

export type DayCell = {
  date: string; // YYYY-MM-DD
  day: number;
  outcome: 'extended' | 'missed' | null;
};

const pad = (n: number) => String(n).padStart(2, '0');
export const isoDate = (y: number, m: number, d: number) => `${y}-${pad(m)}-${pad(d)}`;

/**
 * Weeks (Monday first) for a month; null cells pad the first and last week.
 * Extended days are green, broken and silent misses are both "missed" (grey).
 */
export function buildMonth(year: number, month: number, events: StreakEvent[]): (DayCell | null)[][] {
  const byDate = new Map(events.map((e) => [e.local_date, e.outcome]));
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const firstWeekday = (new Date(Date.UTC(year, month - 1, 1)).getUTCDay() + 6) % 7; // Mon = 0

  const cells: (DayCell | null)[] = Array.from({ length: firstWeekday }, () => null);
  for (let d = 1; d <= daysInMonth; d++) {
    const date = isoDate(year, month, d);
    const outcome = byDate.get(date);
    cells.push({ date, day: d, outcome: outcome ? (outcome === 'extended' ? 'extended' : 'missed') : null });
  }
  while (cells.length % 7 !== 0) cells.push(null);

  const weeks: (DayCell | null)[][] = [];
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));
  return weeks;
}

export function shiftMonth(year: number, month: number, delta: number): { year: number; month: number } {
  const index = year * 12 + (month - 1) + delta;
  return { year: Math.floor(index / 12), month: (index % 12) + 1 };
}

export function monthLabel(year: number, month: number): string {
  return new Date(Date.UTC(year, month - 1, 1)).toLocaleString(undefined, {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
}
