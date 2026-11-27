import { ClientModel } from "../models/Client";
import { User } from "../models/User";
import { MaPeriod, IMaPeriod } from "../models/MaPeriod";
import { ReportSubmission } from "../models/ReportSubmission";
import { ReportAuditEvent } from "../models/ReportAuditEvent";
import {
  currentReportingPeriod,
  daysBetween,
  shiftPeriod,
  isPeriodKey,
} from "../utils/maDeadlines";
import { MA_CLIENT_FILTER } from "./maTrackingService";
import { getAccountantSupervisorIds } from "../utils/accountantSupervisors";

// ═════════════════════════════════════════════════════════════════
// Accountant performance on monthly Management Accounts.
//
// Three stages are measured separately (spec §11B):
//   1. Timely submission   — did the accountants submit for review by the 15th?
//   2. Supervisory review  — how long did it sit with the Accountant Supervisor?
//   3. Timely delivery     — was it actually sent to the client by the 15th?
//
// Lateness is split by WHO HELD THE REPORT: every moment after the deadline
// is charged to whoever currently has it (accountants / supervisor / the
// delivery step), using the append-only audit trail, so a supervisor's slow
// review is never counted against an accountant.
// ═════════════════════════════════════════════════════════════════

export type Owner = "accountant" | "supervisor" | "delivery";

export interface Transition {
  at: Date;
  to: Owner | "done";
}

/**
 * Pure: days spent with each party AFTER the deadline, until `end`
 * (sent time, or now). `transitions` must be sorted by time; the report
 * starts out with the accountants.
 */
export function attributeDelay(
  deadline: Date,
  end: Date,
  transitions: Transition[],
): Record<Owner, number> {
  const out: Record<Owner, number> = { accountant: 0, supervisor: 0, delivery: 0 };
  if (end.getTime() <= deadline.getTime()) return out;

  let owner: Owner = "accountant";
  let cursor = new Date(0);
  const add = (from: Date, to: Date, who: Owner) => {
    const a = Math.max(from.getTime(), deadline.getTime());
    const b = Math.min(to.getTime(), end.getTime());
    if (b > a) out[who] += (b - a) / 86_400_000;
  };
  for (const t of transitions) {
    add(cursor, t.at, owner);
    cursor = t.at;
    if (t.to === "done") return out;
    owner = t.to;
  }
  add(cursor, end, owner);
  return out;
}

const ACTION_TO_OWNER: Record<string, Owner | "done"> = {
  submitted: "supervisor",
  resubmitted: "supervisor",
  returned_for_corrections: "accountant",
  reopened: "accountant",
  approved: "delivery",
  delivery_sent: "done",
};

export interface Counters {
  due: number;
  /** Periods whose deadline has passed or that were already submitted — the compliance base. */
  matured: number;
  submittedOnTime: number;
  submittedLate: number;
  notSubmittedOverdue: number;
  approved: number;
  sentOnTime: number;
  sentLate: number;
  awaitingReview: number;
  overdueAlerts: number;
  approvedNotSent: number;
  returnedForCorrections: number;
  /** Average days after the deadline that MAs were (or still are not) submitted. */
  avgDaysLateToSubmit: number | null;
  /** Days past the deadline charged to each party. */
  accountantDelayDays: number;
  supervisorDelayDays: number;
  deliveryDelayDays: number;
  /** % of matured MAs submitted for review by the deadline. */
  submissionCompliancePct: number | null;
  /** % of matured MAs actually sent to the client by the deadline. */
  deliveryCompliancePct: number | null;
}

const emptyCounters = (): Counters => ({
  due: 0,
  matured: 0,
  submittedOnTime: 0,
  submittedLate: 0,
  notSubmittedOverdue: 0,
  approved: 0,
  sentOnTime: 0,
  sentLate: 0,
  awaitingReview: 0,
  overdueAlerts: 0,
  approvedNotSent: 0,
  returnedForCorrections: 0,
  avgDaysLateToSubmit: null,
  accountantDelayDays: 0,
  supervisorDelayDays: 0,
  deliveryDelayDays: 0,
  submissionCompliancePct: null,
  deliveryCompliancePct: null,
});

const round = (n: number, dp = 1) => Math.round(n * 10 ** dp) / 10 ** dp;
const pct = (a: number, b: number) => (b > 0 ? round((a / b) * 100) : null);

interface PeriodFacts {
  period: IMaPeriod;
  workflowStatus: string;
  returned: number;
  delay: Record<Owner, number>;
}

/** Folds one period's facts into a counter set (`accountable` = the role carries the delay). */
function accumulate(
  c: Counters,
  lateDays: number[],
  f: PeriodFacts,
  now: Date,
  accountable: boolean,
) {
  const p = f.period;
  const passed = now.getTime() > p.deadline.getTime();
  c.due++;
  if (passed || p.firstSubmittedAt) c.matured++;

  if (p.firstSubmittedAt) {
    if (p.firstSubmittedAt.getTime() <= p.deadline.getTime()) c.submittedOnTime++;
    else {
      c.submittedLate++;
      lateDays.push(daysBetween(p.deadline, p.firstSubmittedAt));
    }
  } else if (passed) {
    c.notSubmittedOverdue++;
    lateDays.push(daysBetween(p.deadline, now));
  }
  if (p.approvedAt) c.approved++;
  if (f.workflowStatus === "pending_review") c.awaitingReview++;
  if (p.alertActive || (passed && !p.approvedAt && !p.sentAt)) c.overdueAlerts++;
  if (p.approvedAt && !p.sentAt) c.approvedNotSent++;
  if (p.sentAt) {
    if (p.sentAt.getTime() <= p.deadline.getTime()) c.sentOnTime++;
    else c.sentLate++;
  }
  c.returnedForCorrections += f.returned;
  if (accountable) {
    c.accountantDelayDays += f.delay.accountant;
    c.supervisorDelayDays += f.delay.supervisor;
    c.deliveryDelayDays += f.delay.delivery;
  }
}

function finish(c: Counters, lateDays: number[]): Counters {
  c.avgDaysLateToSubmit = lateDays.length
    ? round(lateDays.reduce((a, b) => a + b, 0) / lateDays.length)
    : null;
  c.submissionCompliancePct = pct(c.submittedOnTime, c.matured);
  c.deliveryCompliancePct = pct(c.sentOnTime, c.matured);
  c.accountantDelayDays = round(c.accountantDelayDays);
  c.supervisorDelayDays = round(c.supervisorDelayDays);
  c.deliveryDelayDays = round(c.deliveryDelayDays);
  return c;
}

export interface PerformanceOptions {
  fromPeriod?: string;
  toPeriod?: string;
}

export interface AccountantPerformance {
  accountantId: string;
  name: string;
  email: string;
  /** "Accountant", "Accountant Supervisor" or "CEO" — they all serve clients. */
  roleLabel: string;
  isSelf?: boolean;
  assignedClients: number;
  clientsRequiringMa: number;
  /** Where this accountant is the Primary — the accountable submitter. */
  asPrimary: Counters;
  /**
   * Where this accountant is the Secondary — supporting. Delay days are shown
   * under `sharedDelayDays` instead of being charged to them as well.
   */
  asSecondary: Counters & { sharedDelayDays: number };
  monthly: {
    periodKey: string;
    due: number;
    submittedOnTime: number;
    sentOnTime: number;
    submissionCompliancePct: number | null;
    deliveryCompliancePct: number | null;
  }[];
}

export async function computePerformance(
  accountantIds: string[],
  opts: PerformanceOptions = {},
  now: Date = new Date(),
) {
  const toPeriod = isPeriodKey(opts.toPeriod) ? opts.toPeriod : currentReportingPeriod(now);
  const fromPeriod = isPeriodKey(opts.fromPeriod)
    ? opts.fromPeriod
    : shiftPeriod(toPeriod, -5);

  const accountants = await User.find({
    _id: { $in: accountantIds },
    isActive: true,
  })
    .select("name email role")
    .lean();
  const supervisorIds = await getAccountantSupervisorIds();
  const roleLabelOf = (u: { _id: unknown; role: string }) =>
    u.role === "ceo"
      ? "CEO"
      : supervisorIds.has(String(u._id))
        ? "Accountant Supervisor"
        : "Accountant";

  const periods = await MaPeriod.find({
    periodKey: { $gte: fromPeriod, $lte: toPeriod },
    exempt: { $ne: true },
    $or: [
      { primaryAccountantId: { $in: accountantIds } },
      { secondaryAccountantIds: { $in: accountantIds } },
    ],
  });

  const subs = await ReportSubmission.find({
    _id: { $in: periods.map((p) => p.submissionId).filter(Boolean) },
  })
    .select("status versions")
    .lean();
  const subById = new Map(subs.map((s) => [String(s._id), s]));

  const events = await ReportAuditEvent.find({
    submissionId: { $in: subs.map((s) => s._id) },
    action: { $in: Object.keys(ACTION_TO_OWNER) },
  })
    .sort({ at: 1 })
    .select("submissionId action at")
    .lean();
  const eventsBySub = new Map<string, Transition[]>();
  for (const e of events) {
    const k = String(e.submissionId);
    const list = eventsBySub.get(k) ?? [];
    list.push({ at: e.at, to: ACTION_TO_OWNER[e.action] });
    eventsBySub.set(k, list);
  }

  const facts = new Map<string, PeriodFacts>();
  for (const p of periods) {
    const sub = p.submissionId ? subById.get(String(p.submissionId)) : undefined;
    const end = p.sentAt ?? now;
    facts.set(String(p._id), {
      period: p,
      workflowStatus: sub?.status ?? "not_started",
      returned: (sub?.versions ?? []).filter((v) => v.decision === "returned").length,
      delay: attributeDelay(
        p.deadline,
        end,
        sub ? (eventsBySub.get(String(sub._id)) ?? []) : [],
      ),
    });
  }

  // Live assignment counts (who currently serves how many clients).
  const served = await ClientModel.find({ isSalesLead: { $ne: true }, "assignedTo.0": { $exists: true } })
    .select("assignedTo allocatedAccountant maRequired")
    .lean();
  const maClients = await ClientModel.find(MA_CLIENT_FILTER)
    .select("assignedTo allocatedAccountant")
    .lean();
  // A client counts for someone assigned to it OR holding it as allocated primary.
  const serves = (c: { assignedTo?: unknown[]; allocatedAccountant?: unknown }, id: string) =>
    (c.assignedTo ?? []).some((x) => String(x) === id) ||
    String(c.allocatedAccountant ?? "") === id;

  const result: AccountantPerformance[] = accountants.map((a) => {
    const id = String(a._id);
    const prim = emptyCounters();
    const sec = emptyCounters();
    const primLate: number[] = [];
    const secLate: number[] = [];
    let shared = 0;
    const monthlyMap = new Map<string, Counters>();
    const monthlyLate = new Map<string, number[]>();

    for (const f of facts.values()) {
      const p = f.period;
      if (String(p.primaryAccountantId) === id) {
        accumulate(prim, primLate, f, now, true);
        const m = monthlyMap.get(p.periodKey) ?? emptyCounters();
        accumulate(m, monthlyLate.get(p.periodKey) ?? [], f, now, true);
        monthlyMap.set(p.periodKey, m);
      } else if ((p.secondaryAccountantIds ?? []).some((s) => String(s) === id)) {
        accumulate(sec, secLate, f, now, false);
        shared += f.delay.accountant;
      }
    }

    const monthly = [...monthlyMap.entries()]
      .sort(([x], [y]) => (x < y ? -1 : 1))
      .map(([periodKey, c]) => ({
        periodKey,
        due: c.due,
        submittedOnTime: c.submittedOnTime,
        sentOnTime: c.sentOnTime,
        submissionCompliancePct: pct(c.submittedOnTime, c.matured),
        deliveryCompliancePct: pct(c.sentOnTime, c.matured),
      }));

    return {
      accountantId: id,
      name: a.name,
      email: a.email,
      roleLabel: roleLabelOf(a),
      assignedClients: served.filter((c) => serves(c, id)).length,
      clientsRequiringMa: maClients.filter((c) => serves(c, id)).length,
      asPrimary: finish(prim, primLate),
      asSecondary: { ...finish(sec, secLate), sharedDelayDays: round(shared) },
      monthly,
    };
  });

  result.sort((x, y) => x.name.localeCompare(y.name));
  return { fromPeriod, toPeriod, generatedAt: now, accountants: result };
}