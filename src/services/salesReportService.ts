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
  /** Leads this rep created that sit in each stage right now (not range-limited). */
  pipeline: Record<string, number>;
}

export type SalesActivityTotals = Omit<
  SalesRepActivity,
  "userId" | "name" | "email" | "pipeline"
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
    repPipelineRows,
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
    // Current pipeline broken down by the rep who owns (created) the lead.
    ClientModel.aggregate<{
      _id: { u: mongoose.Types.ObjectId; s: string | null };
      n: number;
    }>([
      { $match: { isSalesLead: true, createdBy: { $in: ids } } },
      {
        $group: {
          _id: { u: "$createdBy", s: "$salesStage" },
          n: { $sum: 1 },
        },
      },
    ]),
  ]);

  const pick = (rows: Counted[], id: unknown) =>
    rows.find((r) => String(r._id) === String(id))?.n ?? 0;
  const stage = (id: unknown, s: string) =>
    stageMoves.find((m) => String(m._id.u) === String(id) && m._id.s === s)
      ?.n ?? 0;

  const repPipeline = (id: unknown) => {
    const out: Record<string, number> = {};
    for (const row of repPipelineRows) {
      if (String(row._id.u) !== String(id)) continue;
      const key = row._id.s ?? "in_discussion"; // unset stage = in discussion
      out[key] = (out[key] ?? 0) + row.n;
    }
    return out;
  };

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
      pipeline: repPipeline(r._id),
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

// ═════════════════════════════════════════════════════════════════
// Drill-down: the clients behind one number in the report.
// ═════════════════════════════════════════════════════════════════

export const ACTIVITY_METRICS = [
  "leadsAdded",
  "meetingsSet",
  "meetingsDone",
  "calls",
  "emails",
  "whatsapp",
  "notes",
  "proposalsSent",
  "agreementsSent",
  "won",
  "lost",
] as const;
export type ActivityMetric = (typeof ACTIVITY_METRICS)[number];

export const PIPELINE_STAGES = [
  "in_discussion",
  "proposal_sent",
  "awaiting_decision",
  "agreement_sent",
  "won",
  "lost",
] as const;

export interface SalesDetailClient {
  clientId: string;
  name: string;
  company?: string;
  industry?: string;
  email?: string;
  phone?: string;
  salesStage?: string;
  /** How many events for this client make up the number. */
  count: number;
  lastAt: string | null;
  /** Up to 5 most recent events, newest first. */
  events: { at: string; label: string }[];
}

interface RawEvent {
  clientId: mongoose.Types.ObjectId;
  at: Date;
  label: string;
}

const trunc = (s: unknown, n = 80) => {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

/** True when `metric` is a pipeline-stage snapshot key such as "stage:won". */
export function parseStageMetric(metric: string): string | null {
  if (!metric.startsWith("stage:")) return null;
  const s = metric.slice(6);
  return (PIPELINE_STAGES as readonly string[]).includes(s) ? s : null;
}

export async function buildSalesRepDetail(
  userId: string,
  metric: string,
  from: Date,
  to: Date,
): Promise<{ metric: string; total: number; clients: SalesDetailClient[] }> {
  const uid = new mongoose.Types.ObjectId(userId);
  const range = (field: string) => ({ [field]: { $gte: from, $lt: to } });
  let events: RawEvent[] = [];
  let snapshotClients: any[] | null = null;

  const stageEvents = async (stageName: string) => {
    const rows = await ClientModel.aggregate<{
      _id: mongoose.Types.ObjectId;
      at: Date;
      note?: string;
    }>([
      { $unwind: "$salesStageHistory" },
      {
        $match: {
          "salesStageHistory.changedBy": uid,
          "salesStageHistory.stage": stageName,
          "salesStageHistory.changedAt": { $gte: from, $lt: to },
        },
      },
      {
        $project: {
          at: "$salesStageHistory.changedAt",
          note: "$salesStageHistory.note",
        },
      },
    ]);
    return rows.map<RawEvent>((r) => ({
      clientId: r._id,
      at: r.at,
      label: r.note ? `Moved to ${stageName.replace("_", " ")} — ${trunc(r.note)}` : `Moved to ${stageName.replace("_", " ")}`,
    }));
  };

  const stageFilter = parseStageMetric(metric);
  if (stageFilter) {
    // Snapshot: leads this rep owns that are in the stage right now.
    const stageMatch =
      stageFilter === "in_discussion"
        ? { $in: ["in_discussion", null] }
        : stageFilter;
    snapshotClients = await ClientModel.find({
      isSalesLead: true,
      createdBy: uid,
      salesStage: stageMatch,
    })
      .sort({ updatedAt: -1 })
      .lean();
  } else {
    switch (metric as ActivityMetric) {
      case "leadsAdded": {
        const rows = await ClientModel.find({ createdBy: uid, ...range("createdAt") })
          .select("_id createdAt")
          .lean();
        events = rows.map((r) => ({ clientId: r._id as any, at: r.createdAt, label: "Lead added" }));
        break;
      }
      case "meetingsSet": {
        const [logged, cal] = await Promise.all([
          ClientMeetingModel.find({ authorId: uid, ...range("createdAt") }).lean(),
          MeetingModel.find({
            organizer: uid,
            clientId: { $exists: true, $ne: null },
            ...range("createdAt"),
          }).lean(),
        ]);
        events = [
          ...logged.map((m: any) => ({ clientId: m.clientId, at: m.createdAt, label: `Meeting set: ${trunc(m.title)}` })),
          ...cal.map((m: any) => ({ clientId: m.clientId, at: m.createdAt, label: `Video meeting set: ${trunc(m.title)}` })),
        ];
        break;
      }
      case "meetingsDone": {
        const [logged, cal] = await Promise.all([
          ClientMeetingModel.find({ authorId: uid, status: "done", ...range("completedAt") }).lean(),
          MeetingModel.find({
            organizer: uid,
            clientId: { $exists: true, $ne: null },
            status: "completed",
            ...range("startTime"),
          }).lean(),
        ]);
        events = [
          ...logged.map((m: any) => ({ clientId: m.clientId, at: m.completedAt ?? m.createdAt, label: `Meeting done: ${trunc(m.title)}` })),
          ...cal.map((m: any) => ({ clientId: m.clientId, at: m.startTime, label: `Video meeting done: ${trunc(m.title)}` })),
        ];
        break;
      }
      case "calls": {
        const rows = await ClientCallModel.find({ authorId: uid, ...range("calledAt") }).lean();
        events = rows.map((c: any) => ({ clientId: c.clientId, at: c.calledAt, label: `Call (${c.direction}): ${trunc(c.summary)}` }));
        break;
      }
      case "emails": {
        const rows = await ClientEmailModel.find({
          authorId: uid,
          direction: "outbound",
          ...range("createdAt"),
        }).lean();
        events = rows.map((e: any) => ({ clientId: e.clientId, at: e.createdAt, label: `Email: ${trunc(e.subject)}` }));
        break;
      }
      case "whatsapp": {
        const rows = await ClientWhatsappMessageModel.find({
          authorId: uid,
          direction: "outbound",
          ...range("createdAt"),
        }).lean();
        events = rows.map((w: any) => ({ clientId: w.clientId, at: w.createdAt, label: `WhatsApp: ${trunc(w.body)}` }));
        break;
      }
      case "notes": {
        const rows = await ClientNoteModel.find({ authorId: uid, ...range("createdAt") }).lean();
        events = rows.map((n: any) => ({ clientId: n.clientId, at: n.createdAt, label: `Note: ${trunc(n.body)}` }));
        break;
      }
      case "proposalsSent":
        events = await stageEvents("proposal_sent");
        break;
      case "agreementsSent":
        events = await stageEvents("agreement_sent");
        break;
      case "won":
        events = await stageEvents("won");
        break;
      case "lost":
        events = await stageEvents("lost");
        break;
      default:
        throw new Error(`Unknown metric: ${metric}`);
    }
  }

  // Group events per client, newest first.
  const byClient = new Map<string, RawEvent[]>();
  for (const e of events) {
    if (!e.clientId) continue;
    const k = String(e.clientId);
    byClient.set(k, [...(byClient.get(k) ?? []), e]);
  }

  const clientDocs: any[] = snapshotClients
    ? snapshotClients
    : await ClientModel.find({
        _id: { $in: [...byClient.keys()].map((k) => new mongoose.Types.ObjectId(k)) },
      }).lean();

  const clients: SalesDetailClient[] = clientDocs.map((c) => {
    const evs = (byClient.get(String(c._id)) ?? []).sort(
      (a, b) => b.at.getTime() - a.at.getTime(),
    );
    return {
      clientId: String(c._id),
      name: c.name,
      company: c.company,
      industry: c.industry,
      email: c.email,
      phone: c.phone,
      salesStage: c.salesStage ?? (c.isSalesLead ? "in_discussion" : undefined),
      count: snapshotClients ? 1 : evs.length,
      lastAt: (evs[0]?.at ?? c.updatedAt)?.toISOString?.() ?? null,
      events: evs.slice(0, 5).map((e) => ({ at: e.at.toISOString(), label: e.label })),
    };
  });

  clients.sort((a, b) => (b.lastAt ?? "").localeCompare(a.lastAt ?? ""));
  return {
    metric,
    total: snapshotClients ? clients.length : events.length,
    clients,
  };
}