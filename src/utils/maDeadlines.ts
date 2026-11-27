/**
 * Management Accounts deadline maths — all in Africa/Nairobi (EAT, UTC+3, no
 * DST). Pure functions only (no I/O) so the rules are easy to test:
 *
 *   The MAs for a reporting month are due to the client by the 15th day of
 *   the FOLLOWING month. "Due today" is the 15th itself; the MAs are overdue
 *   from the moment the 15th has ended in Nairobi (i.e. from 00:00 on the 16th).
 *
 *   January → 15 February … December → 15 January (following year).
 */

const EAT_OFFSET_MS = 3 * 60 * 60 * 1000;
export const MA_DEADLINE_DAY = 15;
const DAY_MS = 24 * 60 * 60 * 1000;

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

export interface PeriodParts {
  year: number;
  /** 1–12 */
  month: number;
}

export const PERIOD_KEY_RE = /^(\d{4})-(0[1-9]|1[0-2])$/;

export const isPeriodKey = (v: unknown): v is string =>
  typeof v === "string" && PERIOD_KEY_RE.test(v);

export const periodKeyOf = ({ year, month }: PeriodParts): string =>
  `${year}-${String(month).padStart(2, "0")}`;

export const parsePeriodKey = (key: string): PeriodParts => {
  const m = PERIOD_KEY_RE.exec(key);
  if (!m) throw new Error(`Invalid period key "${key}" (expected YYYY-MM)`);
  return { year: Number(m[1]), month: Number(m[2]) };
};

/** "October 2026" */
export const periodLabelOf = (key: string): string => {
  const { year, month } = parsePeriodKey(key);
  return `${MONTHS[month - 1]} ${year}`;
};

/** The EAT wall-clock calendar parts of an instant. */
export const eatParts = (d: Date) => {
  const s = new Date(d.getTime() + EAT_OFFSET_MS);
  return {
    year: s.getUTCFullYear(),
    month: s.getUTCMonth() + 1,
    day: s.getUTCDate(),
  };
};

/** "2026-11-15" — the EAT calendar date of an instant. */
export const eatDateKey = (d: Date): string => {
  const p = eatParts(d);
  return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
};

export const shiftPeriod = (key: string, deltaMonths: number): string => {
  const { year, month } = parsePeriodKey(key);
  const idx = year * 12 + (month - 1) + deltaMonths;
  return periodKeyOf({ year: Math.floor(idx / 12), month: (idx % 12) + 1 });
};

/** The reporting month being worked on "now": the previous calendar month in EAT. */
export const currentReportingPeriod = (now: Date = new Date()): string => {
  const { year, month } = eatParts(now);
  return shiftPeriod(periodKeyOf({ year, month }), -1);
};

/**
 * The last instant on which the MAs for `key` can still be sent on time:
 * 23:59:59.999 EAT on the 15th of the following month.
 */
export const deadlineFor = (key: string): Date => {
  const { year, month } = parsePeriodKey(key);
  // Date.UTC rolls month 12 into January of the next year for us.
  return new Date(
    Date.UTC(year, month, MA_DEADLINE_DAY, 23, 59, 59, 999) - EAT_OFFSET_MS,
  );
};

/** "15 November 2026" */
export const deadlineLabel = (key: string): string => {
  const p = eatParts(deadlineFor(key));
  return `${p.day} ${MONTHS[p.month - 1]} ${p.year}`;
};

/** Whole days the deadline has been missed by (0 until the 15th has ended). */
export const daysOverdue = (deadline: Date, now: Date = new Date()): number =>
  now.getTime() <= deadline.getTime()
    ? 0
    : Math.ceil((now.getTime() - deadline.getTime()) / DAY_MS);

/** Fractional days between two instants, never negative. */
export const daysBetween = (from: Date, to: Date): number =>
  Math.max(0, (to.getTime() - from.getTime()) / DAY_MS);

export type DeadlineStatus =
  | "upcoming"
  | "due_today"
  | "overdue_not_submitted"
  | "overdue_pending_review"
  | "approved_awaiting_delivery"
  | "approved_awaiting_delivery_overdue"
  | "sent";

export interface MaStateInput {
  deadline: Date;
  /** Report workflow status, or undefined when nothing has been started. */
  workflowStatus?:
    | "draft"
    | "pending_review"
    | "returned"
    | "approved"
    | "sending"
    | "sent"
    | "delivery_failed";
  sentAt?: Date | null;
}

/**
 * Section 10 of the spec. Note the active *review alert* (see isReviewAlertActive)
 * clears at approval, but this status keeps saying "awaiting delivery" until
 * the report has really gone out — approval is not delivery.
 */
export const computeDeadlineStatus = (
  s: MaStateInput,
  now: Date = new Date(),
): DeadlineStatus => {
  const overdue = now.getTime() > s.deadline.getTime();
  if (s.sentAt || s.workflowStatus === "sent") return "sent";
  const w = s.workflowStatus;
  if (w === "approved" || w === "sending" || w === "delivery_failed") {
    return overdue
      ? "approved_awaiting_delivery_overdue"
      : "approved_awaiting_delivery";
  }
  if (overdue) {
    return w === "pending_review"
      ? "overdue_pending_review"
      : "overdue_not_submitted";
  }
  return eatDateKey(now) === eatDateKey(s.deadline) ? "due_today" : "upcoming";
};

/**
 * The Accountant's overdue alert: lit once the deadline has passed and stays lit
 * while the MAs are unsubmitted OR waiting for the supervisor. It clears only on
 * approval (and a sent report is by definition past approval).
 */
export const isReviewAlertActive = (
  s: MaStateInput,
  now: Date = new Date(),
): boolean => {
  if (now.getTime() <= s.deadline.getTime()) return false;
  const w = s.workflowStatus;
  return !(
    s.sentAt ||
    w === "approved" ||
    w === "sending" ||
    w === "sent" ||
    w === "delivery_failed"
  );
};

export const STATUS_LABEL: Record<DeadlineStatus, string> = {
  upcoming: "Upcoming",
  due_today: "Due Today",
  overdue_not_submitted: "Overdue – Not Submitted",
  overdue_pending_review: "Overdue – Pending Review",
  approved_awaiting_delivery: "Approved – Awaiting Client Delivery",
  approved_awaiting_delivery_overdue:
    "Approved – Awaiting Client Delivery (Overdue)",
  sent: "Sent to Client",
};
