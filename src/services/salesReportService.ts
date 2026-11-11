import mongoose from "mongoose";
import { User } from "../models/User";
import { ClientModel } from "../models/Client";
import { ClientMeetingModel } from "../models/ClientMeeting";
import { ClientNoteModel } from "../models/ClientNote";
import { ClientCallModel } from "../models/ClientCall";
import { ClientEmailModel } from "../models/ClientEmail";
import { ClientWhatsappMessageModel } from "../models/ClientWhatsappMessage";
import { MeetingModel } from "../models/Meeting";

// ═════════════════════════════════════════════════════════════════
// Sales-team activity report. Everything here is read from data the
// app already records — no new collections. Used by:
//   GET  /api/analytics/sales-activity     (CEO, any date range)
//   POST /api/cron/sales-weekly-report     (emails the CEO every Monday)
// ═════════════════════════════════════════════════════════════════

// Africa/Nairobi is UTC+3 all year (no daylight saving).
const EAT_OFFSET_MS = 3 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
export const MAX_REPORT_RANGE_DAYS = 92;

/** Monday 00:00 → next Monday 00:00 (Nairobi time) of the last COMPLETED week. */
export function lastCompletedWeek(now: Date = new Date()): {
  from: Date;
  to: Date;
} {
  const eat = new Date(now.getTime() + EAT_OFFSET_MS);
  const daysSinceMonday = (eat.getUTCDay() + 6) % 7; // Mon = 0 … Sun = 6
  const thisMondayAsUtc = Date.UTC(
    eat.getUTCFullYear(),
    eat.getUTCMonth(),
    eat.getUTCDate() - daysSinceMonday,
  );
  const to = new Date(thisMondayAsUtc - EAT_OFFSET_MS);
  return { from: new Date(to.getTime() - 7 * DAY_MS), to };
}

/** "2026-11-02" is read as midnight in Nairobi; full ISO strings are used as-is. */
export function parseReportDate(value: unknown): Date | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const v = value.trim();
  const d = /^\d{4}-\d{2}-\d{2}$/.test(v)
    ? new Date(`${v}T00:00:00+03:00`)
    : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** e.g. "2 Nov – 8 Nov 2026" (the range's `to` is exclusive). */
export function formatPeriodLabel(from: Date, to: Date): string {
  const opts = { timeZone: "Africa/Nairobi" } as const;
  const last = new Date(to.getTime() - 1);
  const start = from.toLocaleDateString("en-GB", {
    ...opts,
    day: "numeric",
    month: "short",
  });
  const end = last.toLocaleDateString("en-GB", {
    ...opts,
    day: "numeric",
    month: "short",
    year: "numeric",
  });
  return `${start} – ${end}`;
}

export interface SalesRepActivity {
  userId: string;
  name: string;
  email: string;
  leadsAdded: number;
  meetingsSet: number;
  meetingsDone: number;
  calls: number;
  emails: number;
  whatsapp: number;
  /** calls + outbound emails + outbound WhatsApp messages */
  discussions: number;
  notes: number;
  proposalsSent: number;
  agreementsSent: number;
  won: number;
  lost: number;
}

export type SalesActivityTotals = Omit<
  SalesRepActivity,
  "userId" | "name" | "email"
>;

export interface SalesActivityReport {
  from: string;
  to: string;
  generatedAt: string;
  totals: SalesActivityTotals;
  reps: SalesRepActivity[];
  /** Snapshot of the whole sales pipeline right now (not limited to the range). */
  pipeline: Record<string, number>;
  /** Pipeline leads by industry right now, largest first. */
  industries: { industry: string; count: number }[];
}

type Counted = { _id: mongoose.Types.ObjectId; n: number };

export async function buildSalesActivityReport(
  from: Date,
  to: Date,
): Promise<SalesActivityReport> {
  const reps = await User.find({ role: "sales_person", isActive: true })
    .select("name email")
    .sort({ name: 1 })
    .lean();
  const ids = reps.map((r) => r._id);
  const inRange = (field: string) => ({ [field]: { $gte: from, $lt: to } });

  const countBy = (
    model: mongoose.Model<any>,
    field: string,
    match: Record<string, unknown>,
  ) =>
    model.aggregate<Counted>([
      { $match: { ...match, [field]: { $in: ids } } },
      { $group: { _id: `$${field}`, n: { $sum: 1 } } },
    ]);

  const [
    leads,
    loggedSet,
    loggedDone,
    calendarSet,
    calendarDone,
    calls,
    emails,
    whatsapp,
    notes,
    stageMoves,
    pipelineRows,
    industryRows,
  ] = await Promise.all([
    countBy(ClientModel, "createdBy", inRange("createdAt")),
    // Meetings logged against a client…
    countBy(ClientMeetingModel, "authorId", inRange("createdAt")),
    countBy(ClientMeetingModel, "authorId", {
      status: "done",
      ...inRange("completedAt"),
    }),
    // …and calendar (video) meetings the rep organised that are tied to a client.
    countBy(MeetingModel, "organizer", {
      clientId: { $exists: true, $ne: null },
      ...inRange("createdAt"),
    }),
    countBy(MeetingModel, "organizer", {
      clientId: { $exists: true, $ne: null },
      status: "completed",
      ...inRange("startTime"),
    }),
    countBy(ClientCallModel, "authorId", inRange("calledAt")),
    countBy(ClientEmailModel, "authorId", {
      direction: "outbound",
      ...inRange("createdAt"),
    }),
    countBy(ClientWhatsappMessageModel, "authorId", {
      direction: "outbound",
      ...inRange("createdAt"),
    }),
    countBy(ClientNoteModel, "authorId", inRange("createdAt")),
    ClientModel.aggregate<{
      _id: { u: mongoose.Types.ObjectId; s: string };
      n: number;
    }>([
      { $unwind: "$salesStageHistory" },
      {
        $match: {
          "salesStageHistory.changedBy": { $in: ids },
          "salesStageHistory.changedAt": { $gte: from, $lt: to },
        },
      },
      {
        $group: {
          _id: {
            u: "$salesStageHistory.changedBy",
            s: "$salesStageHistory.stage",
          },
          n: { $sum: 1 },
        },
      },
    ]),
    ClientModel.aggregate<{ _id: string; n: number }>([
      { $match: { isSalesLead: true } },
      { $group: { _id: "$salesStage", n: { $sum: 1 } } },
    ]),
    ClientModel.aggregate<{ _id: string; n: number }>([
      { $match: { isSalesLead: true } },
      {
        $group: {
          _id: {
            $cond: [
              { $gt: [{ $strLenCP: { $ifNull: ["$industry", ""] } }, 0] },
              "$industry",
              "Unspecified",
            ],
          },
          n: { $sum: 1 },
        },
      },
      { $sort: { n: -1 } },
      { $limit: 10 },
    ]),
  ]);

  const pick = (rows: Counted[], id: unknown) =>
    rows.find((r) => String(r._id) === String(id))?.n ?? 0;
  const stage = (id: unknown, s: string) =>
    stageMoves.find((m) => String(m._id.u) === String(id) && m._id.s === s)
      ?.n ?? 0;

  const repRows: SalesRepActivity[] = reps.map((r) => {
    const callsN = pick(calls, r._id);
    const emailsN = pick(emails, r._id);
    const waN = pick(whatsapp, r._id);
    return {
      userId: String(r._id),
      name: r.name,
      email: r.email,
      leadsAdded: pick(leads, r._id),
      meetingsSet: pick(loggedSet, r._id) + pick(calendarSet, r._id),
      meetingsDone: pick(loggedDone, r._id) + pick(calendarDone, r._id),
      calls: callsN,
      emails: emailsN,
      whatsapp: waN,
      discussions: callsN + emailsN + waN,
      notes: pick(notes, r._id),
      proposalsSent: stage(r._id, "proposal_sent"),
      agreementsSent: stage(r._id, "agreement_sent"),
      won: stage(r._id, "won"),
      lost: stage(r._id, "lost"),
    };
  });

  const totals = repRows.reduce<SalesActivityTotals>(
    (t, r) => ({
      leadsAdded: t.leadsAdded + r.leadsAdded,
      meetingsSet: t.meetingsSet + r.meetingsSet,
      meetingsDone: t.meetingsDone + r.meetingsDone,
      calls: t.calls + r.calls,
      emails: t.emails + r.emails,
      whatsapp: t.whatsapp + r.whatsapp,
      discussions: t.discussions + r.discussions,
      notes: t.notes + r.notes,
      proposalsSent: t.proposalsSent + r.proposalsSent,
      agreementsSent: t.agreementsSent + r.agreementsSent,
      won: t.won + r.won,
      lost: t.lost + r.lost,
    }),
    {
      leadsAdded: 0,
      meetingsSet: 0,
      meetingsDone: 0,
      calls: 0,
      emails: 0,
      whatsapp: 0,
      discussions: 0,
      notes: 0,
      proposalsSent: 0,
      agreementsSent: 0,
      won: 0,
      lost: 0,
    },
  );

  return {
    from: from.toISOString(),
    to: to.toISOString(),
    generatedAt: new Date().toISOString(),
    totals,
    reps: repRows,
    pipeline: Object.fromEntries(
      pipelineRows.map((r) => [r._id ?? "in_discussion", r.n]),
    ),
    industries: industryRows.map((r) => ({ industry: r._id, count: r.n })),
  };
}