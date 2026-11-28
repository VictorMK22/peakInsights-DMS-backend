import { clientLabel } from "../utils/clientLabel";
import { Types } from "mongoose";
import { ClientModel, IClient } from "../models/Client";
import { User } from "../models/User";
import { MaPeriod, IMaPeriod } from "../models/MaPeriod";
import { ReportSubmission, IReportSubmission } from "../models/ReportSubmission";
import {
  computeDeadlineStatus,
  currentReportingPeriod,
  daysOverdue,
  deadlineFor,
  deadlineLabel,
  eatDateKey,
  isReviewAlertActive,
  periodLabelOf,
  shiftPeriod,
  STATUS_LABEL,
  DeadlineStatus,
} from "../utils/maDeadlines";
import {
  resolveClientTeam,
  logReportEvent,
  notifyUsers,
} from "./reportTeamService";
import { sendMaOverdueEmail } from "./emailService";

// ═════════════════════════════════════════════════════════════════
// Monthly Management Accounts tracking: the durable per-client-per-month
// record, the overdue-alert lifecycle, and the scheduled monitor.
//
//   Alert lifecycle (spec §9–10):
//     deadline passes ──► alert ON
//     submitted for review ──► alert STAYS ON
//     approved ──► alert OFF  (delivery is tracked separately)
//     sent ──► period completed
// ═════════════════════════════════════════════════════════════════

const FRONTEND = process.env.FRONTEND_URL ?? "http://localhost:5173";
/** Re-nudge the accountants every N days while an alert stays on. */
const REMINDER_EVERY_DAYS = Number(process.env.MA_OVERDUE_REMINDER_DAYS) || 3;

const POST_APPROVAL = ["approved", "sending", "sent", "delivery_failed"];

type Id = Types.ObjectId | string;

/** Clients that are being served (not sales leads) and owe monthly MAs. */
export const MA_CLIENT_FILTER = {
  isSalesLead: { $ne: true },
  maRequired: { $ne: false },
  needsReallocation: { $ne: true },
  "assignedTo.0": { $exists: true },
} as const;

export const clientOwesPeriod = (
  c: Pick<IClient, "maRequired" | "maStartPeriod">,
  periodKey: string,
): boolean =>
  c.maRequired !== false && (!c.maStartPeriod || c.maStartPeriod <= periodKey);

// ─── Period rows ──────────────────────────────────────────────────

/** Gets (creating if needed) the MA period row for a client + reporting month. */
export async function ensureMaPeriod(
  client: IClient,
  periodKey: string,
): Promise<IMaPeriod> {
  const existing = await MaPeriod.findOne({ clientId: client._id, periodKey });
  if (existing) {
    if (!existing.submissionId) await refreshTeam(existing, client);
    return existing;
  }
  const team = await resolveClientTeam(client);
  try {
    return await MaPeriod.create({
      clientId: client._id,
      periodKey,
      periodLabel: periodLabelOf(periodKey),
      deadline: deadlineFor(periodKey),
      primaryAccountantId: team.primary?._id,
      secondaryAccountantIds: team.secondaries.map((s) => s._id),
    });
  } catch (err: any) {
    if (err?.code === 11000) {
      // Another request created it first.
      return (await MaPeriod.findOne({ clientId: client._id, periodKey }))!;
    }
    throw err;
  }
}

/** Until the report is under way the accountable team follows the client's current assignment. */
async function refreshTeam(period: IMaPeriod, client: IClient): Promise<void> {
  const team = await resolveClientTeam(client);
  const primary = team.primary?._id;
  const sec = team.secondaries.map((s) => s._id);
  const changed =
    String(primary ?? "") !== String(period.primaryAccountantId ?? "") ||
    sec.map(String).sort().join() !==
      (period.secondaryAccountantIds ?? []).map(String).sort().join();
  if (changed) {
    period.primaryAccountantId = primary;
    period.secondaryAccountantIds = sec;
    await period.save();
  }
}

/**
 * Re-derives a period's stored milestones and alert state from its
 * report. Called after every workflow transition and by the monitor, so the
 * stored history is always consistent with the report.
 */
export async function syncMaPeriod(
  periodOrId: IMaPeriod | Id,
  now: Date = new Date(),
  actorId?: Id,
): Promise<IMaPeriod> {
  const period =
    typeof periodOrId === "object" && "save" in (periodOrId as any)
      ? (periodOrId as IMaPeriod)
      : (await MaPeriod.findById(periodOrId as Id))!;

  const sub = period.submissionId
    ? await ReportSubmission.findById(period.submissionId)
    : null;

  period.firstSubmittedAt = sub?.firstSubmittedAt ?? undefined;
  period.lastSubmittedAt = sub?.submittedAt ?? undefined;
  period.approvedAt =
    sub && POST_APPROVAL.includes(sub.status)
      ? (sub.approvedAt ?? undefined)
      : undefined;
  period.sentAt = sub?.sentAt ?? undefined;

  const active = period.exempt
    ? false
    : isReviewAlertActive(
        { deadline: period.deadline, workflowStatus: sub?.status, sentAt: period.sentAt },
        now,
      );

  if (active && !period.alertActive) {
    const first = !period.overdueSince;
    period.alertActive = true;
    period.overdueSince = period.overdueSince ?? period.deadline;
    period.alertHistory.push({ activatedAt: first ? period.deadline : now });
    await period.save();
    await logReportEvent({
      submissionId: period.submissionId,
      clientId: period.clientId,
      periodKey: period.periodKey,
      action: "overdue_triggered",
      actorId,
      details: { deadline: period.deadline, reopened: !first },
    });
    return period;
  }

  if (!active && period.alertActive) {
    const last = period.alertHistory[period.alertHistory.length - 1];
    const reason = period.exempt
      ? "exempted"
      : period.sentAt && !period.approvedAt
        ? "sent"
        : "approved";
    if (last && !last.clearedAt) {
      last.clearedAt = period.approvedAt ?? now;
      last.clearReason = reason;
    }
    period.alertActive = false;
    await period.save();
    await logReportEvent({
      submissionId: period.submissionId,
      clientId: period.clientId,
      periodKey: period.periodKey,
      action: "overdue_cleared",
      actorId,
      details: { reason, clearedAt: last?.clearedAt },
    });
    return period;
  }

  await period.save();
  return period;
}

// ─── Views ────────────────────────────────────────────────────────

export interface PersonRef {
  id: string;
  name: string;
}

export interface MaView {
  periodId: string;
  clientId: string;
  clientName: string;
  periodKey: string;
  periodLabel: string;
  deadline: Date;
  deadlineLabel: string;
  deadlineStatus: DeadlineStatus;
  deadlineStatusLabel: string;
  workflowStatus: string; // report status, or "not_started"
  submissionId?: string;
  primary: PersonRef | null;
  secondaries: PersonRef[];
  firstSubmittedAt?: Date;
  lastSubmittedAt?: Date;
  approvedAt?: Date;
  sentAt?: Date;
  daysOverdue: number;
  alertActive: boolean;
  /** Approved but not yet sent, and past the deadline. */
  deliveryOverdue: boolean;
  overdueSince?: Date;
  returnedCount: number;
  /** Taken off the books ("not required") by the CEO / supervisor. */
  exempt: boolean;
}

async function nameMap(ids: Id[]): Promise<Map<string, string>> {
  const unique = [...new Set(ids.filter(Boolean).map(String))];
  if (!unique.length) return new Map();
  const users = await User.find({ _id: { $in: unique } })
    .select("name")
    .lean();
  return new Map(users.map((u) => [String(u._id), u.name]));
}

export async function buildMaViews(
  periods: IMaPeriod[],
  now: Date = new Date(),
): Promise<MaView[]> {
  if (!periods.length) return [];
  const [clients, subs] = await Promise.all([
    ClientModel.find({ _id: { $in: periods.map((p) => p.clientId) } })
      .select("name company")
      .lean(),
    ReportSubmission.find({
      _id: { $in: periods.map((p) => p.submissionId).filter(Boolean) },
    }).lean(),
  ]);
  const clientName = new Map(clients.map((c) => [String(c._id), clientLabel(c)]));
  const subById = new Map(subs.map((s) => [String(s._id), s]));
  const names = await nameMap(
    periods.flatMap((p) => [
      ...(p.primaryAccountantId ? [p.primaryAccountantId] : []),
      ...(p.secondaryAccountantIds ?? []),
    ]),
  );
  const ref = (id?: Id): PersonRef | null =>
    id ? { id: String(id), name: names.get(String(id)) ?? "Unknown" } : null;

  return periods.map((p) => {
    const sub = p.submissionId ? subById.get(String(p.submissionId)) : undefined;
    const state = {
      deadline: p.deadline,
      workflowStatus: sub?.status as IReportSubmission["status"] | undefined,
      sentAt: p.sentAt,
    };
    const status = computeDeadlineStatus(state, now);
    return {
      periodId: String(p._id),
      clientId: String(p.clientId),
      clientName: clientName.get(String(p.clientId)) ?? "Unknown client",
      periodKey: p.periodKey,
      periodLabel: p.periodLabel,
      deadline: p.deadline,
      deadlineLabel: deadlineLabel(p.periodKey),
      deadlineStatus: status,
      deadlineStatusLabel: STATUS_LABEL[status],
      workflowStatus: sub?.status ?? "not_started",
      submissionId: sub ? String(sub._id) : undefined,
      primary: ref(p.primaryAccountantId),
      secondaries: (p.secondaryAccountantIds ?? [])
        .map((s) => ref(s))
        .filter((s): s is PersonRef => !!s),
      firstSubmittedAt: p.firstSubmittedAt,
      lastSubmittedAt: p.lastSubmittedAt,
      approvedAt: p.approvedAt,
      sentAt: p.sentAt,
      daysOverdue: p.sentAt || p.approvedAt ? 0 : daysOverdue(p.deadline, now),
      alertActive: isReviewAlertActive(state, now) && !p.exempt,
      deliveryOverdue: status === "approved_awaiting_delivery_overdue",
      overdueSince: p.overdueSince,
      returnedCount: (sub?.versions ?? []).filter((v) => v.decision === "returned")
        .length,
      exempt: !!p.exempt,
    };
  });
}

/** The Management Accounts tracking panel for one client (spec §7). */
export async function getClientMaTracking(
  client: IClient,
  now: Date = new Date(),
) {
  const periodKey = currentReportingPeriod(now);
  const owes = clientOwesPeriod(client, periodKey);
  const hasTeam = (client.assignedTo ?? []).length > 0;

  if (owes && hasTeam) await ensureMaPeriod(client, periodKey);

  const periods = await MaPeriod.find({ clientId: client._id })
    .sort({ periodKey: -1 })
    .limit(12);
  const views = await buildMaViews(periods, now);

  const lastSentPeriod = await MaPeriod.findOne({
    clientId: client._id,
    sentAt: { $ne: null },
  }).sort({ sentAt: -1 });
  const lastSentView = lastSentPeriod
    ? (await buildMaViews([lastSentPeriod], now))[0]
    : null;

  const team = await resolveClientTeam(client);
  return {
    clientId: String(client._id),
    required: client.maRequired !== false,
    startPeriod: client.maStartPeriod ?? null,
    exemptReason: client.maExemptReason ?? null,
    currentPeriodKey: periodKey,
    primary: team.primary
      ? { id: String(team.primary._id), name: team.primary.name }
      : null,
    secondaries: team.secondaries.map((s) => ({
      id: String(s._id),
      name: s.name,
    })),
    lastSent: lastSentView
      ? {
          sentAt: lastSentView.sentAt,
          periodKey: lastSentView.periodKey,
          periodLabel: lastSentView.periodLabel,
        }
      : null,
    current: owes ? (views.find((v) => v.periodKey === periodKey) ?? null) : null,
    history: views,
  };
}

/**
 * Active overdue alerts. Computed live from the period rows (not from the
 * stored flag) so they appear the moment the deadline passes even if the
 * scheduled monitor has not run yet.
 */
export async function listActiveAlerts(
  opts: { accountantId?: string; accountantIds?: string[] },
  now: Date = new Date(),
): Promise<MaView[]> {
  const filter: Record<string, unknown> = {
    deadline: { $lt: now },
    approvedAt: null,
    sentAt: null,
    exempt: { $ne: true },
  };
  const ids = opts.accountantIds ?? (opts.accountantId ? [opts.accountantId] : []);
  if (ids.length) {
    filter.$or = [
      { primaryAccountantId: { $in: ids } },
      { secondaryAccountantIds: { $in: ids } },
    ];
  }
  const periods = await MaPeriod.find(filter).sort({ deadline: 1 }).limit(500);
  const views = await buildMaViews(periods, now);
  return views.filter((v) => v.alertActive);
}

/**
 * An accountant's own MA worklist: this month's row for every client they
 * serve (created on demand, so it never depends on the scheduler having run)
 * plus any earlier month that has still not been sent.
 */
export async function listMyMaPeriods(
  userId: string,
  now: Date = new Date(),
): Promise<MaView[]> {
  const periodKey = currentReportingPeriod(now);
  // The CEO / an accountant supervisor can hold a client as its allocated
  // (primary) accountant, so look at that as well as assignedTo.
  const clients = await ClientModel.find({
    ...MA_CLIENT_FILTER,
    $or: [{ assignedTo: userId }, { allocatedAccountant: userId }],
  });
  const mine: IMaPeriod[] = [];
  for (const c of clients) {
    if (!clientOwesPeriod(c, periodKey)) continue;
    const team = await resolveClientTeam(c);
    const involved =
      String(team.primary?._id) === userId ||
      team.secondaries.some((x) => String(x._id) === userId);
    if (!involved) continue;
    const row = await ensureMaPeriod(c, periodKey);
    if (!row.exempt) mine.push(row);
  }
  const earlier = await MaPeriod.find({
    sentAt: null,
    exempt: { $ne: true },
    periodKey: { $ne: periodKey },
    $or: [{ primaryAccountantId: userId }, { secondaryAccountantIds: userId }],
  });
  const views = await buildMaViews([...mine, ...earlier], now);
  return views.sort((a, b) => (a.periodKey === b.periodKey ? a.clientName.localeCompare(b.clientName) : a.periodKey < b.periodKey ? -1 : 1));
}

/**
 * Delivery monitoring: every period for a reporting month (or every period
 * that is approved/overdue-but-unsent), with the separate delivery status.
 */
export async function deliveryMonitor(
  opts: { periodKey?: string; accountantIds?: string[] },
  now: Date = new Date(),
): Promise<MaView[]> {
  const filter: Record<string, unknown> = { exempt: { $ne: true } };
  if (opts.periodKey) filter.periodKey = opts.periodKey;
  else filter.$or = [{ sentAt: null }];
  if (opts.accountantIds?.length) {
    filter.$and = [
      {
        $or: [
          { primaryAccountantId: { $in: opts.accountantIds } },
          { secondaryAccountantIds: { $in: opts.accountantIds } },
        ],
      },
    ];
  }
  const periods = await MaPeriod.find(filter)
    .sort({ periodKey: -1, deadline: 1 })
    .limit(1000);
  return buildMaViews(periods, now);
}

// ─── Scheduled monitor ────────────────────────────────────────────

export interface MonitorSummary {
  period: string;
  clientsChecked: number;
  periodsCreated: number;
  openPeriods: number;
  alertsActive: number;
  alertsCleared: number;
  notificationsSent: number;
  skippedDuplicates: number;
  failures: { clientId?: string; periodId?: string; error: string }[];
}

/**
 * Idempotent: safe to run many times a day. It
 *   1. makes sure every client that owes MAs has a row for the reporting month,
 *   2. re-syncs every period that has not been sent (so late months keep being
 *      tracked until they are really delivered),
 *   3. notifies BOTH accountants about each active alert — once on the first
 *      overdue day, then a reminder every MA_OVERDUE_REMINDER_DAYS days — and
 *      never twice for the same day, even across concurrent runs.
 * One bad client never stops the rest; errors are collected and returned.
 */
export async function runMaDeadlineMonitor(
  now: Date = new Date(),
): Promise<MonitorSummary> {
  const period = currentReportingPeriod(now);
  const summary: MonitorSummary = {
    period,
    clientsChecked: 0,
    periodsCreated: 0,
    openPeriods: 0,
    alertsActive: 0,
    alertsCleared: 0,
    notificationsSent: 0,
    skippedDuplicates: 0,
    failures: [],
  };

  // 1. Create the current reporting month's rows.
  const clients = await ClientModel.find(MA_CLIENT_FILTER);
  for (const client of clients) {
    summary.clientsChecked++;
    if (!clientOwesPeriod(client, period)) continue;
    try {
      const before = await MaPeriod.exists({ clientId: client._id, periodKey: period });
      await ensureMaPeriod(client, period);
      if (!before) summary.periodsCreated++;
    } catch (err: any) {
      summary.failures.push({ clientId: String(client._id), error: String(err?.message ?? err) });
    }
  }

  // 2 + 3. Everything not yet sent keeps being tracked.
  const open = await MaPeriod.find({ sentAt: null, exempt: { $ne: true } });
  summary.openPeriods = open.length;
  const clientDocs = new Map(
    (
      await ClientModel.find({ _id: { $in: open.map((p) => p.clientId) } }).select(
        "name company maRequired maStartPeriod",
      )
    ).map((c) => [String(c._id), c]),
  );

  for (const p of open) {
    try {
      const client = clientDocs.get(String(p.clientId));
      if (client && !clientOwesPeriod(client, p.periodKey)) {
        // Exempted since the row was created: stop alerting, keep the record.
        p.exempt = true;
        await syncMaPeriod(p, now);
        await logReportEvent({
          clientId: p.clientId,
          periodKey: p.periodKey,
          action: "period_exempted",
        });
        summary.alertsCleared++;
        continue;
      }

      const wasActive = p.alertActive;
      const synced = await syncMaPeriod(p, now);
      if (wasActive && !synced.alertActive) summary.alertsCleared++;
      if (!synced.alertActive) continue;
      summary.alertsActive++;

      const result = await notifyOverdue(synced, client ? clientLabel(client) : "Client", now);
      summary.notificationsSent += result.sent;
      summary.skippedDuplicates += result.skipped;
    } catch (err: any) {
      summary.failures.push({ periodId: String(p._id), error: String(err?.message ?? err) });
    }
  }
  return summary;
}

/**
 * Sends the overdue notice for today if one is due. The `$push` is guarded on
 * the day key, so of two overlapping runs only one wins the claim and sends.
 */
async function notifyOverdue(
  p: IMaPeriod,
  clientName: string,
  now: Date,
): Promise<{ sent: number; skipped: number }> {
  const dateKey = eatDateKey(now);
  const last = p.notifications[p.notifications.length - 1];
  if (last) {
    const lastDay = new Date(`${last.dateKey}T00:00:00Z`).getTime();
    const today = new Date(`${dateKey}T00:00:00Z`).getTime();
    if ((today - lastDay) / 86_400_000 < REMINDER_EVERY_DAYS)
      return { sent: 0, skipped: 1 };
  }
  const recipientIds = [
    ...(p.primaryAccountantId ? [p.primaryAccountantId] : []),
    ...(p.secondaryAccountantIds ?? []),
  ];
  if (!recipientIds.length) return { sent: 0, skipped: 0 };

  const kind = p.notifications.length === 0 ? "overdue_initial" : "overdue_reminder";
  const claim = await MaPeriod.updateOne(
    { _id: p._id, "notifications.dateKey": { $ne: dateKey } },
    {
      $push: {
        notifications: { kind, dateKey, userIds: recipientIds, at: now },
      },
    },
  );
  if (claim.modifiedCount === 0) return { sent: 0, skipped: 1 };

  const days = daysOverdue(p.deadline, now);
  const dl = deadlineLabel(p.periodKey);
  const message = `Overdue Management Accounts – ${clientName}: the ${p.periodLabel} MAs were due on ${dl} and have not yet been sent to the client (${days} day${days === 1 ? "" : "s"} overdue). Please complete them and submit for review.`;
  const link = `${FRONTEND}/accountant/ma-reports?client=${p.clientId}&period=${p.periodKey}`;

  await notifyUsers(recipientIds, message, "ma_overdue", {
    clientId: String(p.clientId),
    periodKey: p.periodKey,
    submissionId: p.submissionId ? String(p.submissionId) : undefined,
    audience: "accountant",
  });

  const users = await User.find({ _id: { $in: recipientIds }, isActive: true })
    .select("name email")
    .lean();
  await Promise.all(
    users.map((u) =>
      sendMaOverdueEmail(u.email, {
        toName: u.name,
        clientName,
        periodLabel: p.periodLabel,
        deadlineLabel: dl,
        daysOverdue: days,
        link,
        reminder: kind === "overdue_reminder",
      }).catch((err) => console.error("[MA overdue] email failed", u.email, err)),
    ),
  );

  await logReportEvent({
    submissionId: p.submissionId,
    clientId: p.clientId,
    periodKey: p.periodKey,
    action: "overdue_notified",
    details: { kind, dateKey, recipients: recipientIds.map(String) },
  });
  return { sent: recipientIds.length, skipped: 0 };
}

export { shiftPeriod };