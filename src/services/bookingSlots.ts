/**
 * Pure availability maths for public booking links — no database, no
 * network, no clock of its own (callers pass `now`), so it is trivial to
 * test. The DB-facing half lives in bookingService.ts.
 *
 * Everything is done with plain UTC arithmetic on the fixed UTC+03:00 EAT
 * offset (Kenya has no daylight saving), so the result is the same
 * whatever timezone the server happens to run in.
 */

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const EAT_OFFSET = 3 * HOUR;

export interface SlotConfig {
  durationMinutes: number;
  bufferMinutes: number;
  minNoticeHours: number;
  maxDaysAhead: number;
  workStartHour: number;
  workEndHour: number;
  /** 0 = Sunday … 6 = Saturday, in EAT. */
  workDays: number[];
  slotStepMinutes: number;
}

export interface TimeInterval {
  start: Date;
  end: Date;
}

export interface Slot {
  start: Date;
  end: Date;
}

/** The instant of 00:00 EAT on the EAT calendar day containing `t`. */
export const eatMidnight = (t: number): number =>
  Math.floor((t + EAT_OFFSET) / DAY) * DAY - EAT_OFFSET;

/** Weekday (0 = Sunday) of the EAT day starting at `midnight`. */
export const eatWeekday = (midnight: number): number =>
  new Date(midnight + EAT_OFFSET).getUTCDay();

/** "YYYY-MM-DD" of the EAT calendar day containing `t`. */
export const eatDateKey = (t: number): string =>
  new Date(t + EAT_OFFSET).toISOString().slice(0, 10);

/**
 * Every bookable start time for a link, soonest first.
 *
 * A slot is offered when ALL of these hold:
 *  - it falls on a working day, entirely inside working hours (EAT);
 *  - it starts no sooner than `now + minNoticeHours` and no later than
 *    `now + maxDaysAhead`;
 *  - it (padded by `bufferMinutes` each side) overlaps nothing in `busy`.
 *
 * `range` narrows the result to [from, to) — a slot is included when its
 * START is in that window.
 */
export function computeSlots(
  cfg: SlotConfig,
  busy: TimeInterval[],
  now: Date,
  range?: { from?: Date; to?: Date },
): Slot[] {
  const earliest = now.getTime() + cfg.minNoticeHours * HOUR;
  const latest = now.getTime() + cfg.maxDaysAhead * DAY;
  const from = Math.max(range?.from?.getTime() ?? earliest, earliest);
  const to = Math.min(range?.to?.getTime() ?? latest, latest);
  if (!(from < to)) return [];

  const duration = cfg.durationMinutes * MIN;
  const buffer = cfg.bufferMinutes * MIN;
  const step = Math.max(cfg.slotStepMinutes, 1) * MIN;
  const padded = busy.map((b) => ({
    start: b.start.getTime() - buffer,
    end: b.end.getTime() + buffer,
  }));

  const slots: Slot[] = [];
  for (let day = eatMidnight(from); day < to; day += DAY) {
    if (!cfg.workDays.includes(eatWeekday(day))) continue;
    const opens = day + cfg.workStartHour * HOUR;
    const closes = day + cfg.workEndHour * HOUR;
    for (let s = opens; s + duration <= closes; s += step) {
      if (s < from || s >= to) continue;
      const e = s + duration;
      if (padded.some((b) => s < b.end && e > b.start)) continue;
      slots.push({ start: new Date(s), end: new Date(e) });
    }
  }
  return slots;
}
