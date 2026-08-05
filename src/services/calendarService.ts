import mongoose from "mongoose";
import { MeetingModel } from "../models/Meeting";
import { CalendarBlockModel } from "../models/CalendarBlock";
import { User } from "../models/User";

// ─────────────────────────────────────────────────────────────────
// Shared shapes
// ─────────────────────────────────────────────────────────────────

export interface BusyInterval {
  start: Date;
  end: Date;
  source: "meeting" | "block";
  title: string;
  meetingId?: string;
}

export interface ParticipantConflict {
  userId: string;
  name: string;
  conflicts: BusyInterval[];
}

export interface SuggestedSlot {
  start: Date;
  end: Date;
}

const WORK_DAY_START_HOUR = 8; // 08:00
const WORK_DAY_END_HOUR = 18; // 18:00
const SLOT_STEP_MINUTES = 15;
const SUGGESTION_SEARCH_DAYS = 7;
const MAX_SUGGESTIONS = 5;

const overlaps = (
  aStart: Date,
  aEnd: Date,
  bStart: Date,
  bEnd: Date,
): boolean => aStart < bEnd && aEnd > bStart;

/**
 * Every interval during which `userId` is busy, within [from, to]:
 *   - meetings where they're the organizer or an attendee who hasn't
 *     declined, on a meeting that hasn't been cancelled
 *   - personal calendar blocks (out-of-office, focus time, etc.)
 */
export const getUserBusyIntervals = async (
  userId: string,
  from: Date,
  to: Date,
  excludeMeetingId?: string,
): Promise<BusyInterval[]> => {
  const meetingFilter: Record<string, unknown> = {
    status: { $ne: "cancelled" },
    startTime: { $lt: to },
    endTime: { $gt: from },
    $or: [
      { organizer: userId },
      {
        attendees: {
          $elemMatch: { userId, status: { $ne: "declined" } },
        },
      },
    ],
  };
  if (excludeMeetingId) {
    meetingFilter["_id"] = { $ne: excludeMeetingId };
  }

  const [meetings, blocks] = await Promise.all([
    MeetingModel.find(meetingFilter).select("title startTime endTime").lean(),
    CalendarBlockModel.find({
      userId,
      startTime: { $lt: to },
      endTime: { $gt: from },
    })
      .select("title startTime endTime")
      .lean(),
  ]);

  const intervals: BusyInterval[] = [
    ...meetings.map((m) => ({
      start: m.startTime,
      end: m.endTime,
      source: "meeting" as const,
      title: m.title,
      meetingId: String(m._id),
    })),
    ...blocks.map((b) => ({
      start: b.startTime,
      end: b.endTime,
      source: "block" as const,
      title: b.title,
    })),
  ];

  return intervals.sort((a, b) => a.start.getTime() - b.start.getTime());
};

/**
 * Checks a proposed [start, end) window against every given user's
 * calendar and returns only the users who actually have a conflict,
 * each with the specific overlapping interval(s).
 */
export const checkConflicts = async (
  userIds: string[],
  start: Date,
  end: Date,
  excludeMeetingId?: string,
): Promise<ParticipantConflict[]> => {
  const uniqueIds = [...new Set(userIds)];
  const users = await User.find({ _id: { $in: uniqueIds } })
    .select("name")
    .lean();
  const nameById = new Map(users.map((u) => [String(u._id), u.name]));

  const results: ParticipantConflict[] = [];

  for (const userId of uniqueIds) {
    const busy = await getUserBusyIntervals(
      userId,
      start,
      end,
      excludeMeetingId,
    );
    const conflicts = busy.filter((b) => overlaps(start, end, b.start, b.end));
    if (conflicts.length > 0) {
      results.push({
        userId,
        name: nameById.get(userId) ?? "Unknown user",
        conflicts,
      });
    }
  }

  return results;
};

/**
 * Scans forward from `searchFrom` (defaults to now) across working
 * hours (08:00–18:00, Mon–Fri) looking for windows of `durationMinutes`
 * where none of `userIds` have a conflict. Returns up to
 * MAX_SUGGESTIONS candidate slots.
 */
export const suggestAvailableSlots = async (
  userIds: string[],
  durationMinutes: number,
  searchFrom: Date = new Date(),
): Promise<SuggestedSlot[]> => {
  const uniqueIds = [...new Set(userIds)];
  const rangeEnd = new Date(searchFrom);
  rangeEnd.setDate(rangeEnd.getDate() + SUGGESTION_SEARCH_DAYS);

  // Pull every user's busy intervals once for the whole search window,
  // rather than re-querying per candidate slot.
  const busyByUser = new Map<string, BusyInterval[]>();
  for (const userId of uniqueIds) {
    busyByUser.set(
      userId,
      await getUserBusyIntervals(userId, searchFrom, rangeEnd),
    );
  }

  const suggestions: SuggestedSlot[] = [];
  const cursor = new Date(searchFrom);
  // Round up to the next SLOT_STEP_MINUTES boundary.
  cursor.setSeconds(0, 0);
  const remainder = cursor.getMinutes() % SLOT_STEP_MINUTES;
  if (remainder !== 0)
    cursor.setMinutes(cursor.getMinutes() + (SLOT_STEP_MINUTES - remainder));

  while (cursor < rangeEnd && suggestions.length < MAX_SUGGESTIONS) {
    const day = cursor.getDay();
    const hour = cursor.getHours();

    const withinWorkDay =
      day !== 0 &&
      day !== 6 &&
      hour >= WORK_DAY_START_HOUR &&
      hour < WORK_DAY_END_HOUR;

    if (!withinWorkDay) {
      // Jump to the next day's work-start.
      cursor.setDate(cursor.getDate() + (day === 6 ? 2 : 1));
      cursor.setHours(WORK_DAY_START_HOUR, 0, 0, 0);
      continue;
    }

    const slotStart = new Date(cursor);
    const slotEnd = new Date(cursor.getTime() + durationMinutes * 60_000);

    // Slot must finish before the work day ends.
    const workEndToday = new Date(cursor);
    workEndToday.setHours(WORK_DAY_END_HOUR, 0, 0, 0);
    if (slotEnd > workEndToday) {
      cursor.setDate(cursor.getDate() + (day === 5 ? 3 : 1));
      cursor.setHours(WORK_DAY_START_HOUR, 0, 0, 0);
      continue;
    }

    const hasConflict = uniqueIds.some((userId) =>
      (busyByUser.get(userId) ?? []).some((b) =>
        overlaps(slotStart, slotEnd, b.start, b.end),
      ),
    );

    if (!hasConflict) {
      suggestions.push({ start: slotStart, end: slotEnd });
    }

    cursor.setMinutes(cursor.getMinutes() + SLOT_STEP_MINUTES);
  }

  return suggestions;
};

/**
 * Materializes the individual Meeting documents for a recurring
 * series given a base occurrence's start/end and a recurrence rule.
 * Returns an array of { startTime, endTime } pairs (including the
 * first occurrence) — the caller is responsible for actually
 * inserting them as Meeting documents.
 */
export interface RecurrenceRuleInput {
  frequency: "none" | "daily" | "weekly" | "monthly" | "custom";
  interval?: number;
  daysOfWeek?: number[];
  endDate?: string | Date;
  count?: number;
}

const MAX_OCCURRENCES = 52;

export const expandRecurrence = (
  firstStart: Date,
  firstEnd: Date,
  rule: RecurrenceRuleInput,
): { startTime: Date; endTime: Date }[] => {
  if (!rule || rule.frequency === "none") {
    return [{ startTime: firstStart, endTime: firstEnd }];
  }

  const durationMs = firstEnd.getTime() - firstStart.getTime();
  const interval = Math.max(1, rule.interval ?? 1);
  const endDate = rule.endDate ? new Date(rule.endDate) : undefined;
  const maxCount = Math.min(rule.count ?? MAX_OCCURRENCES, MAX_OCCURRENCES);

  const occurrences: { startTime: Date; endTime: Date }[] = [];

  if (rule.frequency === "weekly" || rule.frequency === "custom") {
    const daysOfWeek =
      rule.daysOfWeek && rule.daysOfWeek.length > 0
        ? [...new Set(rule.daysOfWeek)].sort()
        : [firstStart.getDay()];

    // Walk week by week (respecting `interval` weeks between cycles),
    // and within each active week emit one occurrence per selected
    // weekday that falls on/after firstStart.
    let weekCursor = new Date(firstStart);
    weekCursor.setDate(weekCursor.getDate() - weekCursor.getDay()); // back to Sunday

    let weekIndex = 0;
    while (occurrences.length < maxCount) {
      if (weekIndex % interval === 0) {
        for (const dow of daysOfWeek) {
          const dayDate = new Date(weekCursor);
          dayDate.setDate(dayDate.getDate() + dow);
          dayDate.setHours(
            firstStart.getHours(),
            firstStart.getMinutes(),
            firstStart.getSeconds(),
            0,
          );
          if (dayDate < firstStart) continue;
          if (endDate && dayDate > endDate) {
            weekIndex = Infinity; // stop outer loop
            break;
          }
          const start = dayDate;
          const end = new Date(start.getTime() + durationMs);
          occurrences.push({ startTime: start, endTime: end });
          if (occurrences.length >= maxCount) break;
        }
      }
      weekIndex += 1;
      weekCursor.setDate(weekCursor.getDate() + 7);
      if (weekIndex > 5000) break; // hard safety valve
    }
  } else if (rule.frequency === "daily") {
    let current = new Date(firstStart);
    while (occurrences.length < maxCount) {
      if (endDate && current > endDate) break;
      const end = new Date(current.getTime() + durationMs);
      occurrences.push({ startTime: new Date(current), endTime: end });
      current.setDate(current.getDate() + interval);
    }
  } else if (rule.frequency === "monthly") {
    let current = new Date(firstStart);
    while (occurrences.length < maxCount) {
      if (endDate && current > endDate) break;
      const end = new Date(current.getTime() + durationMs);
      occurrences.push({ startTime: new Date(current), endTime: end });
      current = new Date(current);
      current.setMonth(current.getMonth() + interval);
    }
  }

  return occurrences.length > 0
    ? occurrences
    : [{ startTime: firstStart, endTime: firstEnd }];
};

export const newSeriesId = (): mongoose.Types.ObjectId =>
  new mongoose.Types.ObjectId();
